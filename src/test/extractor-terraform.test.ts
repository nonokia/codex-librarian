import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../store/store.js';
import { indexRepo } from '../app/index.js';
import { TerraformExtractor } from '../extractors/terraform.js';
import { parseUnifiedDiff } from '../core/diff.js';
import { retrieveForDiff } from '../core/retrieval.js';
import { assembleReviewPack } from '../core/contextpack.js';
import { runEval, loadGoldenFile } from '../app/eval.js';
import { PROTOCOL_NAME, PROTOCOL_VERSION, parseCapabilities } from '../protocol/scip.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tfExtractorDir = join(repoRoot, 'tf-extractor');
const fixture = join(repoRoot, 'eval', 'fixtures', 'terraform-taskflow');
const golden = join(repoRoot, 'eval', 'golden', 'terraform-taskflow.json');

const hasGo = spawnSync('go', ['version'], { encoding: 'utf8' }).status === 0;

/**
 * Build the extractor binary once for the whole file — `go run` per test would
 * recompile each time. Tests skip (not fail) without a Go toolchain, mirroring
 * the extractor's own degrade-don't-block policy.
 */
let binary: string | null = null;
function builtBinary(): string {
  if (binary) return binary;
  const out = join(mkdtempSync(join(tmpdir(), 'librarian-tf-bin-')), 'librarian-tf-extractor');
  const res = spawnSync('go', ['build', '-o', out, '.'], { cwd: tfExtractorDir, encoding: 'utf8' });
  assert.equal(res.status, 0, `go build failed: ${res.stderr}`);
  binary = out;
  return out;
}

function indexedFixture(): Store {
  process.env.LIBRARIAN_TF_EXTRACTOR = builtBinary();
  const store = new Store(':memory:');
  indexRepo(store, fixture);
  return store;
}

test('terraform fixture indexes with the block-kind taxonomy', { skip: !hasGo }, () => {
  const store = indexedFixture();
  const stats = store.stats();
  assert.equal(stats.byExtension.tf, 10, 'all fixture .tf files indexed');
  for (const kind of ['module', 'variable', 'resource', 'data', 'output', 'locals']) {
    assert.ok((stats.byKind[kind] ?? 0) > 0, `expected some ${kind} symbols`);
  }

  // a resource is addressed by its <type>.<name>
  const web = store.findSymbols('aws_instance.web')[0];
  assert.ok(web, 'resource addressed as type.name');
  assert.equal(web.kind, 'resource');
  assert.equal(web.file, 'compute.tf');

  // the file-level module symbol and a `module` block coexist as kind `module`
  const moduleKinds = store.findSymbols('', 500).filter((s) => s.kind === 'module');
  assert.ok(moduleKinds.some((s) => s.name === 'network.tf'), 'file-module anchor');
  assert.ok(moduleKinds.some((s) => s.name === 'module.vpc'), 'module block reuses kind module');
  store.close();
});

test('references resolve across files (variable → resource blast radius)', { skip: !hasGo }, () => {
  const store = indexedFixture();
  const count = store.findSymbols('var.instance_count')[0];
  const web = store.findSymbols('aws_instance.web')[0];
  // aws_instance.web (compute.tf) references var.instance_count (variables.tf)
  assert.ok(
    store.edgesOf(web.id).out.some((e) => e.kind === 'references' && e.toId === count.id && e.resolved),
    'cross-file var reference resolves to the variable symbol'
  );
  // and it is reachable as an in-edge of the variable (the blast radius)
  assert.ok(
    store.edgesOf(count.id).in.some((e) => e.fromId === web.id),
    'the variable sees the resource that depends on it'
  );
  store.close();
});

test('module source is an imports edge to the local module files', { skip: !hasGo }, () => {
  const store = indexedFixture();
  const vpc = store.findSymbols('module.vpc')[0];
  const imports = store.edgesOf(vpc.id).out.filter((e) => e.kind === 'imports' && e.resolved);
  const targetFiles = new Set(
    imports.map((e) => store.findSymbols('', 500).find((s) => s.id === e.toId)?.file)
  );
  assert.ok(targetFiles.has('modules/vpc/main.tf'), 'source resolves to the module directory files');
  assert.ok(targetFiles.has('modules/vpc/variables.tf'));
  store.close();
});

test('a diff on a variable seeds retrieval and packs the affected resource', { skip: !hasGo }, () => {
  const store = indexedFixture();
  const count = store.findSymbols('var.instance_count')[0];
  const diff = `--- a/variables.tf\n+++ b/variables.tf\n@@ -${count.spanStart},1 +${count.spanStart},1 @@\n-x\n+y\n`;
  const pack = retrieveForDiff(store, fixture, parseUnifiedDiff(diff), {});
  assert.ok(pack.seeds.some((s) => s.name === 'var.instance_count'), 'span overlap seeds the variable');

  const review = assembleReviewPack(diff, pack);
  const related = [...review.related, ...review.callers, ...review.callees];
  assert.ok(
    related.some((i) => i.name === 'aws_instance.web'),
    'the resource that depends on the variable lands in the pack'
  );
  store.close();
});

test('eval baseline: the reference graph recovers the golden blast radius', { skip: !hasGo }, () => {
  const store = indexedFixture();
  const report = runEval(store, () => fixture, loadGoldenFile(golden), { hops: 2, budget: 8000 });
  // HCL references are lexically explicit, so the graph should fully recover the
  // curated blast radius. Lock the baseline; a regression drops recall here.
  assert.equal(report.aggregate.microRecall, 1, 'perfect micro recall on the terraform golden');
  assert.equal(report.aggregate.perfectCases, report.aggregate.cases);
  store.close();
});

test('without a Go toolchain the claimed files degrade to file-level modules', () => {
  const root = mkdtempSync(join(tmpdir(), 'librarian-tf-degrade-'));
  writeFileSync(join(root, 'main.tf'), 'resource "aws_s3_bucket" "b" {\n  bucket = "x"\n}\n');
  const saved = { bin: process.env.LIBRARIAN_TF_EXTRACTOR, path: process.env.PATH };
  delete process.env.LIBRARIAN_TF_EXTRACTOR;
  process.env.PATH = '/nonexistent';
  try {
    const results = new TerraformExtractor().extract(root, [join(root, 'main.tf')]);
    assert.equal(results.length, 1);
    assert.deepEqual(
      results[0].symbols.map((s) => s.kind),
      ['module'],
      'file-level module symbol only'
    );
  } finally {
    if (saved.bin !== undefined) process.env.LIBRARIAN_TF_EXTRACTOR = saved.bin;
    process.env.PATH = saved.path;
    rmSync(root, { recursive: true, force: true });
  }
});

test('--capabilities answers the plugin-protocol handshake, reads no stdin', { skip: !hasGo }, () => {
  const res = spawnSync(builtBinary(), ['--capabilities'], { encoding: 'utf8', input: 'IGNORED' });
  assert.equal(res.status, 0);
  const caps = parseCapabilities(JSON.parse(res.stdout));
  assert.equal(caps.protocol, PROTOCOL_NAME);
  assert.equal(caps.protocolVersion, PROTOCOL_VERSION);
  assert.equal(caps.name, 'librarian-terraform');
  assert.deepEqual(caps.extensions, ['.tf']);
});
