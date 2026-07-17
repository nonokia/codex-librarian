import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../store/store.js';
import { indexRepo } from '../app/index.js';
import { DockerfileExtractor } from '../extractors/dockerfile.js';
import { isDockerfilePath } from '../protocol/scip-export.js';
import { parseUnifiedDiff } from '../core/diff.js';
import { retrieveForDiff } from '../core/retrieval.js';
import { assembleReviewPack } from '../core/contextpack.js';
import { runEval, loadGoldenFile } from '../app/eval.js';
import { PROTOCOL_NAME, PROTOCOL_VERSION, parseCapabilities } from '../protocol/scip.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const extractorDir = join(repoRoot, 'dockerfile-extractor');
const fixture = join(repoRoot, 'eval', 'fixtures', 'dockerfile-taskflow');
const golden = join(repoRoot, 'eval', 'golden', 'dockerfile-taskflow.json');

const hasGo = spawnSync('go', ['version'], { encoding: 'utf8' }).status === 0;

let binary: string | null = null;
function builtBinary(): string {
  if (binary) return binary;
  const out = join(mkdtempSync(join(tmpdir(), 'librarian-df-bin-')), 'librarian-dockerfile-extractor');
  const res = spawnSync('go', ['build', '-o', out, '.'], { cwd: extractorDir, encoding: 'utf8' });
  assert.equal(res.status, 0, `go build failed: ${res.stderr}`);
  binary = out;
  return out;
}

function indexedFixture(): Store {
  process.env.LIBRARIAN_DOCKERFILE_EXTRACTOR = builtBinary();
  const store = new Store(':memory:');
  indexRepo(store, fixture);
  return store;
}

test('claims routes all three Dockerfile naming forms, not by extension', () => {
  assert.ok(isDockerfilePath('Dockerfile'));
  assert.ok(isDockerfilePath('web/Dockerfile'));
  assert.ok(isDockerfilePath('Dockerfile.worker'));
  assert.ok(isDockerfilePath('images/proxy.dockerfile'));
  assert.ok(!isDockerfilePath('Dockerfile-old.md'));
  assert.ok(!isDockerfilePath('myDockerfile'));
  assert.ok(!isDockerfilePath('nginx.conf'));
});

test('dockerfile fixture indexes stages and ARGs alongside TS files', { skip: !hasGo }, () => {
  const store = indexedFixture();
  const stats = store.stats();
  for (const kind of ['stage', 'variable', 'module']) {
    assert.ok((stats.byKind[kind] ?? 0) > 0, `expected some ${kind} symbols`);
  }
  const build = store.findSymbols('stage.build')[0];
  assert.ok(build, 'stage addressed as stage.name');
  assert.equal(build.kind, 'stage');
  assert.equal(build.file, 'Dockerfile');
  // all three naming forms were routed to the extractor
  const modules = store.findSymbols('', 200).filter((s) => s.kind === 'module');
  for (const f of ['Dockerfile', 'Dockerfile.worker', 'proxy.dockerfile']) {
    assert.ok(modules.some((s) => s.name === f), `${f} indexed`);
  }
  // and the TS files coexist in the same index
  assert.ok(store.findSymbols('runWorker')[0], 'TS symbols coexist');
  store.close();
});

test('stage graph: FROM / COPY --from / --mount=from resolve to prior stages', { skip: !hasGo }, () => {
  const store = indexedFixture();
  const deps = store.findSymbols('stage.deps')[0];
  const build = store.findSymbols('stage.build')[0];
  const runtime = store.findSymbols('stage.runtime')[0];

  assert.ok(
    store.edgesOf(build.id).out.some((e) => e.toId === deps.id && e.resolved),
    'FROM deps resolves to the prior stage'
  );
  assert.ok(
    store.edgesOf(runtime.id).out.some((e) => e.toId === build.id && e.resolved),
    'COPY --from=build resolves'
  );
  // external base image is an unresolved imports edge with the tag stripped
  assert.ok(
    store.edgesOf(deps.id).out.some((e) => e.kind === 'imports' && !e.resolved && e.toName === 'node'),
    'FROM node:${V}-alpine leaves an unresolved imports edge on repository "node"'
  );
  store.close();
});

test('ARG blast radius: stages using ${ARG} reference the declaration', { skip: !hasGo }, () => {
  const store = indexedFixture();
  const arg = store.findSymbols('arg.NODE_VERSION').find((s) => s.file === 'Dockerfile')!;
  const users = store.edgesOf(arg.id).in.map((e) => e.fromId);
  const deps = store.findSymbols('stage.deps')[0];
  const runtime = store.findSymbols('stage.runtime')[0];
  assert.ok(users.includes(deps.id), 'deps uses NODE_VERSION');
  assert.ok(users.includes(runtime.id), 'runtime uses NODE_VERSION');
  store.close();
});

test('COPY sources stay honestly unresolved with the repo-relative path', { skip: !hasGo }, () => {
  const store = indexedFixture();
  const deps = store.findSymbols('stage.deps')[0];
  assert.ok(
    store.edgesOf(deps.id).out.some((e) => !e.resolved && e.toName === 'package.json'),
    'existing literal source emits an unresolved path edge (future post-pass target)'
  );
  store.close();
});

test('a diff on a stage seeds retrieval and packs dependent stages', { skip: !hasGo }, () => {
  const store = indexedFixture();
  const deps = store.findSymbols('stage.deps')[0];
  const diff = `--- a/Dockerfile\n+++ b/Dockerfile\n@@ -${deps.spanStart},1 +${deps.spanStart},1 @@\n-x\n+y\n`;
  const pack = retrieveForDiff(store, fixture, parseUnifiedDiff(diff), {});
  assert.ok(pack.seeds.some((s) => s.name === 'stage.deps'), 'span overlap seeds the stage');
  const review = assembleReviewPack(diff, pack);
  const related = [...review.related, ...review.callers, ...review.callees];
  assert.ok(
    related.some((i) => i.name === 'stage.build'),
    'the stage built on the changed stage lands in the pack'
  );
  store.close();
});

test('eval baseline: stage/ARG blast radius recovered; COPY-source gap is measured', { skip: !hasGo }, () => {
  const store = indexedFixture();
  const report = runEval(store, () => fixture, loadGoldenFile(golden), { hops: 2, budget: 8000 });
  // 10/11: the single expected miss is df-005's Dockerfile-via-COPY-source,
  // deliberately unreachable today (resolved=0 by design — see dlog) and kept
  // in the golden as the improvement target for a link-style post-pass.
  assert.equal(report.aggregate.totalExpected, 11);
  assert.equal(report.aggregate.totalMatched, 10);
  assert.equal(report.aggregate.perfectCases, 4);
  store.close();
});

test('without a Go toolchain the claimed files degrade to file-level modules', () => {
  const root = mkdtempSync(join(tmpdir(), 'librarian-df-degrade-'));
  writeFileSync(join(root, 'Dockerfile'), 'FROM alpine:3\nRUN true\n');
  const saved = { bin: process.env.LIBRARIAN_DOCKERFILE_EXTRACTOR, path: process.env.PATH };
  delete process.env.LIBRARIAN_DOCKERFILE_EXTRACTOR;
  process.env.PATH = '/nonexistent';
  try {
    const results = new DockerfileExtractor().extract(root, [join(root, 'Dockerfile')]);
    assert.equal(results.length, 1);
    assert.deepEqual(results[0].symbols.map((s) => s.kind), ['module']);
  } finally {
    if (saved.bin !== undefined) process.env.LIBRARIAN_DOCKERFILE_EXTRACTOR = saved.bin;
    process.env.PATH = saved.path;
    rmSync(root, { recursive: true, force: true });
  }
});

test('--capabilities answers the handshake and announces basename patterns', { skip: !hasGo }, () => {
  const res = spawnSync(builtBinary(), ['--capabilities'], { encoding: 'utf8', input: 'IGNORED' });
  assert.equal(res.status, 0);
  const caps = parseCapabilities(JSON.parse(res.stdout));
  assert.equal(caps.protocol, PROTOCOL_NAME);
  assert.equal(caps.protocolVersion, PROTOCOL_VERSION);
  assert.equal(caps.name, 'librarian-dockerfile');
  assert.deepEqual(caps.extensions, ['.dockerfile']);
  const raw = JSON.parse(res.stdout) as { basenames?: string[] };
  assert.deepEqual(raw.basenames, ['Dockerfile', 'Dockerfile.*']);
});
