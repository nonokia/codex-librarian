import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../store/store.js';
import { indexRepo } from '../app/index.js';
import { GoExtractor } from '../extractors/go.js';
import { parseUnifiedDiff } from '../core/diff.js';
import { retrieveForDiff } from '../core/retrieval.js';
import { assembleReviewPack } from '../core/contextpack.js';
import { PROTOCOL_NAME, PROTOCOL_VERSION, parseCapabilities } from '../protocol/scip.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const goExtractorDir = join(repoRoot, 'go-extractor');
const fixture = join(repoRoot, 'eval', 'fixtures', 'go-taskflow');

const hasGo = spawnSync('go', ['version'], { encoding: 'utf8' }).status === 0;

/**
 * Build the extractor binary once for the whole file — `go run` per test
 * would recompile each time. Tests are skipped (not failed) without a Go
 * toolchain, mirroring the extractor's own degrade-don't-block policy.
 */
let binary: string | null = null;
function builtBinary(): string {
  if (binary) return binary;
  const out = join(mkdtempSync(join(tmpdir(), 'librarian-go-bin-')), 'librarian-go-extractor');
  const res = spawnSync('go', ['build', '-o', out, '.'], { cwd: goExtractorDir, encoding: 'utf8' });
  assert.equal(res.status, 0, `go build failed: ${res.stderr}`);
  binary = out;
  return out;
}

function indexedFixture(): Store {
  process.env.LIBRARIAN_GO_EXTRACTOR = builtBinary();
  const store = new Store(':memory:');
  indexRepo(store, fixture);
  return store;
}

test('go fixture indexes with the full symbol taxonomy', { skip: !hasGo }, () => {
  const store = indexedFixture();
  const stats = store.stats();
  assert.equal(stats.byExtension.go, 10, 'all fixture .go files indexed');
  for (const kind of ['module', 'function', 'method', 'struct', 'interface', 'testblock', 'variable']) {
    assert.ok((stats.byKind[kind] ?? 0) > 0, `expected some ${kind} symbols`);
  }

  const complete = store.findSymbols('MemStore.Complete')[0];
  assert.ok(complete, 'method symbols are container-qualified');
  assert.equal(complete.kind, 'method');
  assert.equal(complete.container, 'MemStore');
  assert.match(complete.signature ?? '', /\(id int64\) error/);
  store.close();
});

test('extends covers interface satisfaction and embedding', { skip: !hasGo }, () => {
  const store = indexedFixture();
  const memStore = store.findSymbols('MemStore')[0];
  const iface = store.findSymbols('Store').find((s) => s.kind === 'interface')!;
  const out = store.edgesOf(memStore.id).out.filter((e) => e.kind === 'extends');
  assert.ok(
    out.some((e) => e.toId === iface.id && e.resolved),
    'MemStore implements Store (types.Implements, no explicit declaration in source)'
  );

  const handler = store.findSymbols('Handler').find((s) => s.kind === 'struct')!;
  const service = store.findSymbols('Service').find((s) => s.kind === 'struct')!;
  assert.ok(
    store.edgesOf(handler.id).out.some((e) => e.kind === 'extends' && e.toId === service.id),
    'struct embedding (*service.Service) is an extends edge'
  );

  const storeIface = store.edgesOf(iface.id).out.filter((e) => e.kind === 'extends');
  const reader = store.findSymbols('Reader').find((s) => s.kind === 'interface')!;
  assert.ok(
    storeIface.some((e) => e.toId === reader.id),
    'interface embedding (Store embeds Reader) is an extends edge'
  );
  store.close();
});

test('calls resolve through the type checker; unresolved keep raw names', { skip: !hasGo }, () => {
  const store = indexedFixture();
  const createTask = store.findSymbols('Service.CreateTask')[0];
  const edges = store.edgesOf(createTask.id).out;
  const storeIface = store.findSymbols('Store').find((s) => s.kind === 'interface')!;
  assert.ok(
    edges.some((e) => e.kind === 'calls' && e.toId === storeIface.id && e.resolved),
    's.store.Add(t) resolves to the Store interface symbol'
  );
  assert.ok(
    edges.some((e) => e.kind === 'calls' && !e.resolved && e.toName === 'fmt.Errorf'),
    'stdlib calls stay unresolved with the callee text as written'
  );
  store.close();
});

test('TestXxx and t.Run subtests become nested testblock symbols', { skip: !hasGo }, () => {
  const store = indexedFixture();
  const blocks = store.symbolsInFile('store/memstore_test.go').filter((s) => s.kind === 'testblock');
  assert.ok(blocks.some((s) => s.name === 'TestMemStoreAdd' && s.container === null));
  const sub = blocks.find((s) => s.name === 't.Run(ids are sequential)');
  assert.ok(sub, 't.Run subtest symbol exists');
  assert.equal(sub!.container, 'TestMemStoreAdd');

  const memAdd = store.findSymbols('MemStore.Add')[0];
  assert.ok(
    store.edgesOf(memAdd.id).in.some((e) => e.fromId === sub!.id && e.kind === 'calls'),
    'edges originate from the subtest block, not the whole test file'
  );
  store.close();
});

test('a diff against a Go method seeds retrieval and packs its callers', { skip: !hasGo }, () => {
  const store = indexedFixture();
  const complete = store.findSymbols('MemStore.Complete')[0];
  const diff = `--- a/store/memstore.go\n+++ b/store/memstore.go\n@@ -${complete.spanStart},1 +${complete.spanStart},1 @@\n-x\n+y\n`;
  const pack = retrieveForDiff(store, fixture, parseUnifiedDiff(diff), {});
  assert.ok(pack.seeds.some((s) => s.name === 'MemStore.Complete'), 'span overlap seeds the method');

  const review = assembleReviewPack(diff, pack);
  assert.ok(
    review.tests.some((t) => t.file === 'store/memstore_test.go'),
    '_test.go context lands in the tests section'
  );
  store.close();
});

test('without a Go toolchain the claimed files degrade to file-level modules', () => {
  const root = mkdtempSync(join(tmpdir(), 'librarian-go-degrade-'));
  writeFileSync(join(root, 'main.go'), 'package main\n\nfunc main() {}\n');
  const saved = { bin: process.env.LIBRARIAN_GO_EXTRACTOR, path: process.env.PATH };
  process.env.LIBRARIAN_GO_EXTRACTOR = '';
  delete process.env.LIBRARIAN_GO_EXTRACTOR;
  process.env.PATH = '/nonexistent';
  try {
    const results = new GoExtractor().extract(root, [join(root, 'main.go')]);
    assert.equal(results.length, 1);
    assert.deepEqual(
      results[0].symbols.map((s) => s.kind),
      ['module'],
      'file-level module symbol only'
    );
  } finally {
    if (saved.bin !== undefined) process.env.LIBRARIAN_GO_EXTRACTOR = saved.bin;
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
  assert.equal(caps.name, 'librarian-go');
  assert.deepEqual(caps.extensions, ['.go']);
});
