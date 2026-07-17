import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../store/store.js';
import { indexRepo } from '../app/index.js';
import { K8sExtractor } from '../extractors/k8s.js';
import { parseUnifiedDiff } from '../core/diff.js';
import { retrieveForDiff } from '../core/retrieval.js';
import { assembleReviewPack } from '../core/contextpack.js';
import { runEval, loadGoldenFile } from '../app/eval.js';
import { PROTOCOL_NAME, PROTOCOL_VERSION, parseCapabilities } from '../protocol/scip.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const extractorDir = join(repoRoot, 'k8s-extractor');
const fixture = join(repoRoot, 'eval', 'fixtures', 'k8s-taskflow');
const golden = join(repoRoot, 'eval', 'golden', 'k8s-taskflow.json');

const hasGo = spawnSync('go', ['version'], { encoding: 'utf8' }).status === 0;

let binary: string | null = null;
function builtBinary(): string {
  if (binary) return binary;
  const out = join(mkdtempSync(join(tmpdir(), 'librarian-k8s-bin-')), 'librarian-k8s-extractor');
  const res = spawnSync('go', ['build', '-o', out, '.'], { cwd: extractorDir, encoding: 'utf8' });
  assert.equal(res.status, 0, `go build failed: ${res.stderr}`);
  binary = out;
  return out;
}

function indexedFixture(): Store {
  process.env.LIBRARIAN_K8S_EXTRACTOR = builtBinary();
  const store = new Store(':memory:');
  indexRepo(store, fixture);
  return store;
}

test('k8s fixture indexes resources as kind/name documents', { skip: !hasGo }, () => {
  const store = indexedFixture();
  const api = store.findSymbols('Deployment/api').find((s) => s.file === 'base/deployment.yaml');
  assert.ok(api, 'resource addressed as kind/name');
  assert.equal(api!.kind, 'resource');

  // multi-document files: two symbols out of one file
  const inConfig = store.findSymbols('', 200).filter((s) => s.file === 'base/config.yaml');
  const names = inConfig.map((s) => s.name).sort();
  assert.ok(names.includes('ConfigMap/api-config') && names.includes('Secret/api-secrets'),
    '--- separated documents each get a symbol');

  // the kustomization document has its own symbol named by directory
  assert.ok(store.findSymbols('Kustomization/base')[0], 'kustomization symbol');
  assert.ok(store.findSymbols('ConfigMap/prod-config')[0], 'configMapGenerator declares its ConfigMap');
  store.close();
});

test('name references resolve: configMap/secret refs, ingress backend, selector', { skip: !hasGo }, () => {
  const store = indexedFixture();
  const api = store.findSymbols('Deployment/api').find((s) => s.file === 'base/deployment.yaml')!;
  const cm = store.findSymbols('ConfigMap/api-config').find((s) => s.file === 'base/config.yaml')!;
  const svc = store.findSymbols('Service/api')[0];
  const ing = store.findSymbols('Ingress/api')[0];

  assert.ok(
    store.edgesOf(api.id).out.some((e) => e.toId === cm.id && e.resolved),
    'envFrom configMapRef resolves cross-file'
  );
  assert.ok(
    store.edgesOf(ing.id).out.some((e) => e.toId === svc.id && e.resolved),
    'ingress backend.service.name → Service'
  );
  // the Service selector binds to exactly one workload
  assert.ok(
    store.edgesOf(svc.id).out.some((e) => e.toId === api.id && e.resolved && e.toName.startsWith('selector:')),
    'unique selector match binds Service → Deployment'
  );
  store.close();
});

test('ambiguous selectors stay unresolved (never guess)', { skip: !hasGo }, () => {
  const root = mkdtempSync(join(tmpdir(), 'librarian-k8s-sel-'));
  try {
    const dep = (name: string) => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
spec:
  template:
    metadata:
      labels:
        app: shared
`;
    writeFileSync(join(root, 'a.yaml'), dep('a'));
    writeFileSync(join(root, 'b.yaml'), dep('b'));
    writeFileSync(join(root, 'svc.yaml'), `apiVersion: v1
kind: Service
metadata:
  name: shared
spec:
  selector:
    app: shared
`);
    process.env.LIBRARIAN_K8S_EXTRACTOR = builtBinary();
    const store = new Store(':memory:');
    indexRepo(store, root);
    const svc = store.findSymbols('Service/shared')[0];
    const selectorEdges = store.edgesOf(svc.id).out.filter((e) => e.toName.startsWith('selector:'));
    assert.equal(selectorEdges.length, 1);
    assert.equal(selectorEdges[0].resolved, false, 'two matching workloads → unresolved');
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('non-k8s YAML degrades to the file module with zero false edges', { skip: !hasGo }, () => {
  const root = mkdtempSync(join(tmpdir(), 'librarian-k8s-gate-'));
  try {
    writeFileSync(join(root, 'ci.yml'), 'name: CI\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n');
    writeFileSync(join(root, 'helm.yaml'), 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: {{ .Release.Name }}\n');
    process.env.LIBRARIAN_K8S_EXTRACTOR = builtBinary();
    const store = new Store(':memory:');
    indexRepo(store, root);
    const rows = store.findSymbols('', 100);
    assert.deepEqual(
      rows.map((s) => s.kind).sort(),
      ['module', 'module'],
      'GitHub Actions YAML and Helm templates yield module symbols only'
    );
    assert.equal(store.stats().edges, 0, 'no false edges');
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('image references carry the tag-stripped specifier (#35/#40 lockstep)', { skip: !hasGo }, () => {
  const store = indexedFixture();
  const api = store.findSymbols('Deployment/api').find((s) => s.file === 'base/deployment.yaml')!;
  assert.ok(
    store.edgesOf(api.id).out.some(
      (e) => e.kind === 'imports' && !e.resolved && e.toName === 'ghcr.io/acme/taskflow-api'
    ),
    'image: → unresolved imports with :tag stripped'
  );
  store.close();
});

test('a diff on a ConfigMap seeds retrieval and packs the consuming workloads', { skip: !hasGo }, () => {
  const store = indexedFixture();
  const cm = store.findSymbols('ConfigMap/api-config').find((s) => s.file === 'base/config.yaml')!;
  const diff = `--- a/base/config.yaml\n+++ b/base/config.yaml\n@@ -${cm.spanStart},1 +${cm.spanStart},1 @@\n-x\n+y\n`;
  const pack = retrieveForDiff(store, fixture, parseUnifiedDiff(diff), {});
  assert.ok(pack.seeds.some((s) => s.name === 'ConfigMap/api-config'));
  const review = assembleReviewPack(diff, pack);
  const related = [...review.related, ...review.callers, ...review.callees];
  assert.ok(related.some((i) => i.name === 'Deployment/api'), 'consuming Deployment lands in the pack');
  store.close();
});

test('eval baseline: the reference graph recovers the golden blast radius', { skip: !hasGo }, () => {
  const store = indexedFixture();
  const report = runEval(store, () => fixture, loadGoldenFile(golden), { hops: 2, budget: 8000 });
  assert.equal(report.aggregate.microRecall, 1, 'perfect micro recall on the k8s golden');
  assert.equal(report.aggregate.perfectCases, report.aggregate.cases);
  store.close();
});

test('without a Go toolchain the claimed files degrade to file-level modules', () => {
  const root = mkdtempSync(join(tmpdir(), 'librarian-k8s-degrade-'));
  writeFileSync(join(root, 'deploy.yaml'), 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: x\n');
  const saved = { bin: process.env.LIBRARIAN_K8S_EXTRACTOR, path: process.env.PATH };
  delete process.env.LIBRARIAN_K8S_EXTRACTOR;
  process.env.PATH = '/nonexistent';
  try {
    const results = new K8sExtractor().extract(root, [join(root, 'deploy.yaml')]);
    assert.equal(results.length, 1);
    assert.deepEqual(results[0].symbols.map((s) => s.kind), ['module']);
  } finally {
    if (saved.bin !== undefined) process.env.LIBRARIAN_K8S_EXTRACTOR = saved.bin;
    process.env.PATH = saved.path;
    rmSync(root, { recursive: true, force: true });
  }
});

test('--capabilities answers the plugin-protocol handshake', { skip: !hasGo }, () => {
  const res = spawnSync(builtBinary(), ['--capabilities'], { encoding: 'utf8', input: 'IGNORED' });
  assert.equal(res.status, 0);
  const caps = parseCapabilities(JSON.parse(res.stdout));
  assert.equal(caps.protocol, PROTOCOL_NAME);
  assert.equal(caps.protocolVersion, PROTOCOL_VERSION);
  assert.equal(caps.name, 'librarian-k8s');
  assert.deepEqual(caps.extensions, ['.yaml', '.yml']);
});
