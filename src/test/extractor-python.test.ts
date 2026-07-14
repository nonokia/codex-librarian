import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../store/store.js';
import { importScip, indexRepo } from '../app/index.js';
import { PythonExtractor } from '../extractors/python.js';
import { parseUnifiedDiff } from '../core/diff.js';
import { retrieveForDiff } from '../core/retrieval.js';
import { assembleReviewPack } from '../core/contextpack.js';
import { loadGoldenFile, runEval } from '../app/eval.js';
import { SymbolRole } from '@scip-code/scip';
import { PROTOCOL_NAME, PROTOCOL_VERSION, createScipIndex, encodeScip, parseCapabilities } from '../protocol/scip.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixture = join(repoRoot, 'eval', 'fixtures', 'python-taskflow');
const script = join(repoRoot, 'py-extractor', 'extract.py');

const python = spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0 ? 'python3' : null;

function indexedFixture(): Store {
  const store = new Store(':memory:');
  indexRepo(store, fixture);
  return store;
}

test('python fixture indexes with the full symbol taxonomy', { skip: !python }, () => {
  const store = indexedFixture();
  const stats = store.stats();
  assert.equal(stats.byExtension.py, 21, 'all fixture .py files indexed');
  for (const kind of ['module', 'function', 'method', 'class', 'testblock', 'variable']) {
    assert.ok((stats.byKind[kind] ?? 0) > 0, `expected some ${kind} symbols`);
  }

  const complete = store.findSymbols('MemStore.complete')[0];
  assert.ok(complete, 'method symbols are container-qualified');
  assert.equal(complete.kind, 'method');
  assert.equal(complete.container, 'MemStore');
  assert.equal(complete.signature, 'def complete(self, id: int) -> None');
  store.close();
});

test('extends covers base classes and method overrides', { skip: !python }, () => {
  const store = indexedFixture();
  const memStore = store.findSymbols('MemStore').find((s) => s.kind === 'class')!;
  const storeCls = store.findSymbols('Store').find((s) => s.kind === 'class')!;
  const sequence = store.findSymbols('Sequence').find((s) => s.kind === 'class')!;
  const out = store.edgesOf(memStore.id).out.filter((e) => e.kind === 'extends');
  assert.ok(
    out.some((e) => e.toId === storeCls.id && e.resolved),
    'class MemStore(Sequence, Store) → extends Store'
  );
  assert.ok(out.some((e) => e.toId === sequence.id && e.resolved), 'and extends the Sequence mixin');

  // override edges: the only static link between an implementation and the
  // contract it satisfies (Python has no @Override) — see py-extractor pass 5
  const complete = store.findSymbols('MemStore.complete')[0];
  const contract = store.findSymbols('Store.complete')[0];
  assert.ok(
    store.edgesOf(complete.id).out.some((e) => e.kind === 'extends' && e.toId === contract.id),
    'MemStore.complete --extends--> Store.complete (override)'
  );
  const get = store.findSymbols('MemStore.get')[0];
  const readerGet = store.findSymbols('Reader.get')[0];
  assert.ok(
    store.edgesOf(get.id).out.some((e) => e.kind === 'extends' && e.toId === readerGet.id),
    'overrides resolve through the MRO, not just the direct base'
  );

  // a base outside the repo stays unresolved with the name as written
  const notFound = store.findSymbols('NotFoundError').find((s) => s.kind === 'class')!;
  assert.ok(
    store
      .edgesOf(notFound.id)
      .out.some((e) => e.kind === 'extends' && !e.resolved && e.toName === 'RuntimeError'),
    'extending a stdlib class stays unresolved with the raw name'
  );
  store.close();
});

test('calls resolve through self, the MRO, and injected interfaces', { skip: !python }, () => {
  const store = indexedFixture();
  const complete = store.findSymbols('MemStore.complete')[0];
  const edges = store.edgesOf(complete.id).out;

  const get = store.findSymbols('MemStore.get')[0];
  assert.ok(
    edges.some((e) => e.kind === 'calls' && e.toId === get.id && e.resolved),
    'self.get(...) resolves to the same-class method'
  );
  const forId = store.findSymbols('NotFoundError.for_id')[0];
  assert.ok(
    edges.some((e) => e.kind === 'calls' && e.toId === forId.id && e.resolved),
    'NotFoundError.for_id(...) — a classmethod on an imported class — resolves'
  );
  // task = self.get(id) → Optional[Task] → Task.mark_done() resolves
  const markDone = store.findSymbols('Task.mark_done')[0];
  assert.ok(
    edges.some((e) => e.kind === 'calls' && e.toId === markDone.id && e.resolved),
    'a local typed by an annotated return resolves its method calls'
  );

  // the injected-interface call: self._store: Store, learned from __init__
  const completeTask = store.findSymbols('Service.complete_task')[0];
  const storeComplete = store.findSymbols('Store.complete')[0];
  assert.ok(
    store
      .edgesOf(completeTask.id)
      .out.some((e) => e.kind === 'calls' && e.toId === storeComplete.id && e.resolved),
    'self._store.complete(id) resolves to the contract method (attribute type from __init__)'
  );

  // MemStore.add calls the mixin's next_id() through the MRO
  const add = store.findSymbols('MemStore.add')[0];
  const nextId = store.findSymbols('Sequence.next_id')[0];
  assert.ok(
    store.edgesOf(add.id).out.some((e) => e.kind === 'calls' && e.toId === nextId.id),
    'self.next_id() resolves to the inherited method'
  );

  // builtins and duck-typed receivers stay unresolved with the name as written
  const allTasks = store.findSymbols('MemStore.all')[0];
  assert.ok(
    store.edgesOf(allTasks.id).out.some((e) => e.kind === 'calls' && !e.resolved && e.toName === 'list'),
    'a builtin call is kept unresolved with the raw name'
  );
  store.close();
});

test('comprehension element types resolve their calls', { skip: !python }, () => {
  const store = indexedFixture();
  // [task for task in self._store.all() if task.overdue(now)] — all() -> List[Task]
  const overdueTasks = store.findSymbols('Service.overdue_tasks')[0];
  const overdue = store.findSymbols('Task.overdue')[0];
  assert.ok(
    store
      .edgesOf(overdueTasks.id)
      .out.some((e) => e.kind === 'calls' && e.toId === overdue.id && e.resolved),
    'the loop variable of a List[Task]-typed iterable is a Task'
  );
  store.close();
});

test('annotations and constants become references to repo symbols', { skip: !python }, () => {
  const store = indexedFixture();
  const storeCls = store.findSymbols('Store').find((s) => s.kind === 'class')!;
  assert.ok(
    store.edgesOf(storeCls.id).in.some((e) => e.kind === 'references' && e.resolved),
    'Service depends on the Store contract via the __init__ annotation'
  );
  const maxTitle = store.findSymbols('MAX_TITLE').find((s) => s.kind === 'variable')!;
  const createTask = store.findSymbols('Service.create_task')[0];
  assert.ok(
    store
      .edgesOf(maxTitle.id)
      .in.some((e) => e.kind === 'references' && e.fromId === createTask.id),
    'a module-level constant read (inside an f-string) is a resolved reference'
  );
  store.close();
});

test('pytest functions and unittest methods become testblock symbols', { skip: !python }, () => {
  const store = indexedFixture();
  const blocks = store.symbolsInFile('tests/test_memstore.py').filter((s) => s.kind === 'testblock');
  assert.ok(
    blocks.some((s) => s.name === 'test_complete' && s.container === null),
    'a module-level pytest function in a test file → testblock'
  );
  const helper = store.symbolsInFile('tests/test_service.py').find((s) => s.name === 'service');
  assert.equal(helper?.kind, 'function', 'a non-test_* helper in a test file stays a function');
  store.close();
});

test('a diff against a python method seeds retrieval and packs its test context', { skip: !python }, () => {
  const store = indexedFixture();
  const complete = store.findSymbols('MemStore.complete')[0];
  const diff = `--- a/taskflow/store/memstore.py\n+++ b/taskflow/store/memstore.py\n@@ -${complete.spanStart},1 +${complete.spanStart},1 @@\n-x\n+y\n`;
  const pack = retrieveForDiff(store, fixture, parseUnifiedDiff(diff), {});
  assert.ok(pack.seeds.some((s) => s.name === 'MemStore.complete'), 'span overlap seeds the method');

  const review = assembleReviewPack(diff, pack);
  assert.ok(
    review.tests.some((t) => t.file === 'tests/test_memstore.py'),
    'pytest test_*.py context lands in the tests section'
  );
  store.close();
});

test('eval baseline on the python golden set (docs/python-baseline.md)', { skip: !python }, () => {
  const store = indexedFixture();
  const golden = loadGoldenFile(join(repoRoot, 'eval', 'golden', 'python-taskflow.json'));
  const report = runEval(store, fixture, golden, {});
  assert.equal(report.aggregate.cases, 12);
  assert.equal(report.aggregate.totalMatched, 40, 'micro recall 40/42 — the recorded baseline');
  assert.equal(report.aggregate.perfectCases, 10);
  store.close();
});

test('native rows win over a degrade scip-python import, unless --prefer-scip', { skip: !python }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'librarian-py-dispatch-'));
  try {
    // an ext-less index shaped like scip-python output, over a .py path
    const index = createScipIndex({
      metadata: { toolInfo: { name: 'scip-python', version: '0.6.6' }, projectRoot: `file://${dir}` },
      documents: [
        {
          language: 'python',
          relativePath: 'app.py',
          occurrences: [
            {
              symbol: 'scip-python python app 0.1 `app`/imported().',
              symbolRoles: SymbolRole.Definition,
              range: [0, 4, 12],
              enclosingRange: [0, 0, 2, 0],
            },
          ],
          symbols: [{ symbol: 'scip-python python app 0.1 `app`/imported().' }],
        },
      ],
    });
    writeFileSync(join(dir, 'app.scip'), encodeScip(index));

    // default: the Python extractor claims .py, so the degrade doc is skipped
    const store = new Store(':memory:');
    const skipped = importScip(store, join(dir, 'app.scip'), { repoName: 'py', root: dir });
    assert.equal(skipped.degraded, true);
    assert.equal(skipped.skippedNativeFiles, 1, 'native wins (design §4.5)');
    assert.equal(store.findSymbols('imported', 5, 'py').length, 0);

    // --prefer-scip keeps the external rows: an explicit, never silent override
    const kept = importScip(store, join(dir, 'app.scip'), { repoName: 'py', root: dir, preferScip: true });
    assert.equal(kept.skippedNativeFiles, 0);
    assert.equal(store.findSymbols('imported', 5, 'py').length, 1);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a file whose syntax the interpreter cannot parse degrades to file level', { skip: !python }, () => {
  const root = mkdtempSync(join(tmpdir(), 'librarian-py-syntax-'));
  try {
    writeFileSync(join(root, 'ok.py'), 'def works() -> int:\n    return 1\n');
    writeFileSync(join(root, 'broken.py'), 'def nope(:\n    ???\n');
    const results = new PythonExtractor().extract(root, [join(root, 'ok.py'), join(root, 'broken.py')]);
    const broken = results.find((r) => r.file === 'broken.py')!;
    assert.deepEqual(broken.symbols.map((s) => s.kind), ['module'], 'unparseable file → module row only');
    const ok = results.find((r) => r.file === 'ok.py')!;
    assert.ok(ok.symbols.some((s) => s.name === 'works'), 'the other files still extract fully');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('without a python interpreter the claimed files degrade to file-level modules', () => {
  const root = mkdtempSync(join(tmpdir(), 'librarian-py-degrade-'));
  const saved = { bin: process.env.PYTHON_BINARY, explicit: process.env.LIBRARIAN_PY_EXTRACTOR, path: process.env.PATH };
  process.env.PYTHON_BINARY = '';
  delete process.env.LIBRARIAN_PY_EXTRACTOR;
  process.env.PATH = '/nonexistent';
  try {
    writeFileSync(join(root, 'main.py'), 'def main() -> None:\n    pass\n');
    const results = new PythonExtractor().extract(root, [join(root, 'main.py')]);
    assert.equal(results.length, 1);
    assert.deepEqual(results[0].symbols.map((s) => s.kind), ['module'], 'file-level module symbol only');
  } finally {
    if (saved.bin !== undefined) process.env.PYTHON_BINARY = saved.bin;
    else delete process.env.PYTHON_BINARY;
    if (saved.explicit !== undefined) process.env.LIBRARIAN_PY_EXTRACTOR = saved.explicit;
    process.env.PATH = saved.path;
    rmSync(root, { recursive: true, force: true });
  }
});

test('--capabilities answers the plugin-protocol handshake, reads no stdin', { skip: !python }, () => {
  const res = spawnSync(python!, [script, '--capabilities'], { encoding: 'utf8', input: 'IGNORED' });
  assert.equal(res.status, 0);
  const caps = parseCapabilities(JSON.parse(res.stdout));
  assert.equal(caps.protocol, PROTOCOL_NAME);
  assert.equal(caps.protocolVersion, PROTOCOL_VERSION);
  assert.equal(caps.name, 'librarian-py');
  assert.deepEqual(caps.extensions, ['.py', '.pyi']);
});
