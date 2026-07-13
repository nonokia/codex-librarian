import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../store/store.js';
import { indexRepo } from '../app/index.js';
import { PhpExtractor } from '../extractors/php.js';
import { parseUnifiedDiff } from '../core/diff.js';
import { retrieveForDiff } from '../core/retrieval.js';
import { assembleReviewPack } from '../core/contextpack.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixture = join(repoRoot, 'eval', 'fixtures', 'php-taskflow');

const hasPhp = spawnSync('php', ['--version'], { encoding: 'utf8' }).status === 0;

function indexedFixture(): Store {
  const store = new Store(':memory:');
  indexRepo(store, fixture);
  return store;
}

test('php fixture indexes with the full symbol taxonomy', { skip: !hasPhp }, () => {
  const store = indexedFixture();
  const stats = store.stats();
  assert.equal(stats.byExtension.php, 16, 'all fixture .php files indexed');
  for (const kind of ['module', 'function', 'method', 'class', 'interface', 'trait', 'enum', 'testblock', 'variable']) {
    assert.ok((stats.byKind[kind] ?? 0) > 0, `expected some ${kind} symbols (${kind})`);
  }

  const complete = store.findSymbols('MemStore.complete')[0];
  assert.ok(complete, 'method symbols are container-qualified');
  assert.equal(complete.kind, 'method');
  assert.equal(complete.container, 'MemStore');
  assert.match(complete.signature ?? '', /\(int \$id\): void/);
  store.close();
});

test('extends covers implements, interface-extends and trait use', { skip: !hasPhp }, () => {
  const store = indexedFixture();
  const memStore = store.findSymbols('MemStore').find((s) => s.kind === 'class')!;
  const storeIface = store.findSymbols('Store').find((s) => s.kind === 'interface')!;
  const out = store.edgesOf(memStore.id).out.filter((e) => e.kind === 'extends');
  assert.ok(
    out.some((e) => e.toId === storeIface.id && e.resolved),
    'MemStore implements Store (implements → extends edge)'
  );

  const seq = store.findSymbols('Sequence').find((s) => s.kind === 'trait')!;
  assert.ok(
    out.some((e) => e.toId === seq.id && e.resolved),
    'trait use (use Sequence) is a resolved extends edge'
  );

  const reader = store.findSymbols('Reader').find((s) => s.kind === 'interface')!;
  assert.ok(
    store.edgesOf(storeIface.id).out.some((e) => e.kind === 'extends' && e.toId === reader.id),
    'interface extends (Store extends Reader) is an extends edge'
  );

  // extension of a non-repo base stays unresolved with the raw name
  const notFound = store.findSymbols('NotFoundError').find((s) => s.kind === 'class')!;
  assert.ok(
    store.edgesOf(notFound.id).out.some((e) => e.kind === 'extends' && !e.resolved && /RuntimeException/.test(e.toName)),
    'extending a vendor/stdlib class stays unresolved with the name as written'
  );
  store.close();
});

test('calls: $this-> / new / static resolve; dynamic dispatch stays raw', { skip: !hasPhp }, () => {
  const store = indexedFixture();
  const complete = store.findSymbols('MemStore.complete')[0];
  const edges = store.edgesOf(complete.id).out;

  const get = store.findSymbols('MemStore.get')[0];
  assert.ok(
    edges.some((e) => e.kind === 'calls' && e.toId === get.id && e.resolved),
    '$this->get(...) resolves to the same-class method'
  );
  const forId = store.findSymbols('NotFoundError.forId')[0];
  assert.ok(
    edges.some((e) => e.kind === 'calls' && e.toId === forId.id && e.resolved),
    'NotFoundError::forId(...) static call resolves'
  );
  // $task->markDone() — instance dispatch on a non-$this var: unresolvable
  assert.ok(
    edges.some((e) => e.kind === 'calls' && !e.resolved && e.toName === '->markDone'),
    'dynamic instance dispatch is kept unresolved with the method name as written'
  );

  const service = store.findSymbols('Service.createTask')[0];
  assert.ok(
    store.edgesOf(service.id).out.some(
      (e) => e.kind === 'calls' && !e.resolved && e.toName === '->add'
    ),
    '$this->store->add() through an injected interface is dynamic → unresolved'
  );
  store.close();
});

test('type hints become references to repo types', { skip: !hasPhp }, () => {
  const store = indexedFixture();
  const storeIface = store.findSymbols('Store').find((s) => s.kind === 'interface')!;
  // constructor-injected `private Store $store` → references the interface
  assert.ok(
    store.edgesOf(storeIface.id).in.some((e) => e.kind === 'references' && e.resolved),
    'Service depends on the Store interface via a resolved reference'
  );
  const priority = store.findSymbols('Priority').find((s) => s.kind === 'enum')!;
  assert.ok(
    store.edgesOf(priority.id).in.some((e) => e.kind === 'references' && e.resolved),
    'the Priority enum is referenced via property/parameter type hints'
  );
  store.close();
});

test('PHPUnit test methods become testblock symbols (test* and #[Test])', { skip: !hasPhp }, () => {
  const store = indexedFixture();
  const blocks = store.symbolsInFile('tests/Store/MemStoreTest.php').filter((s) => s.kind === 'testblock');
  assert.ok(
    blocks.some((s) => s.name === 'testComplete' && s.container === 'MemStoreTest'),
    'test* method convention → testblock, container = test class'
  );
  const attr = store
    .symbolsInFile('tests/Service/ServiceTest.php')
    .find((s) => s.name === 'rejectsEmptyTitle');
  assert.ok(attr && attr.kind === 'testblock', '#[Test] attribute marks a non-test*-named method as a testblock');
  store.close();
});

test('a diff against a php method seeds retrieval and packs its test context', { skip: !hasPhp }, () => {
  const store = indexedFixture();
  const complete = store.findSymbols('MemStore.complete')[0];
  const diff = `--- a/src/Store/MemStore.php\n+++ b/src/Store/MemStore.php\n@@ -${complete.spanStart},1 +${complete.spanStart},1 @@\n-x\n+y\n`;
  const pack = retrieveForDiff(store, fixture, parseUnifiedDiff(diff), {});
  assert.ok(pack.seeds.some((s) => s.name === 'MemStore.complete'), 'span overlap seeds the method');

  const review = assembleReviewPack(diff, pack);
  assert.ok(
    review.tests.some((t) => t.file === 'tests/Store/MemStoreTest.php'),
    'PHPUnit *Test.php context lands in the tests section'
  );
  store.close();
});

test('without a php interpreter the claimed files degrade to file-level modules', () => {
  const root = mkdtempSync(join(tmpdir(), 'librarian-php-degrade-'));
  writeFileSync(join(root, 'main.php'), "<?php\nfunction main(): void {}\n");
  const saved = { bin: process.env.PHP_BINARY, explicit: process.env.LIBRARIAN_PHP_EXTRACTOR, path: process.env.PATH };
  process.env.PHP_BINARY = '';
  delete process.env.LIBRARIAN_PHP_EXTRACTOR;
  process.env.PATH = '/nonexistent';
  try {
    const results = new PhpExtractor().extract(root, [join(root, 'main.php')]);
    assert.equal(results.length, 1);
    assert.deepEqual(
      results[0].symbols.map((s) => s.kind),
      ['module'],
      'file-level module symbol only'
    );
  } finally {
    if (saved.bin !== undefined) process.env.PHP_BINARY = saved.bin;
    else delete process.env.PHP_BINARY;
    if (saved.explicit !== undefined) process.env.LIBRARIAN_PHP_EXTRACTOR = saved.explicit;
    process.env.PATH = saved.path;
    rmSync(root, { recursive: true, force: true });
  }
});
