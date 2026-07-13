import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SymbolInformation_Kind, SymbolRole } from '@scip-code/scip';
import { symbolId } from '../protocol/extractor.js';
import type { ExtractionResult } from '../protocol/extractor.js';
import { Store } from '../store/store.js';
import { storeToScipPlus } from '../protocol/scip-export.js';
import { importScip, indexRepo } from '../app/index.js';
import { TypeScriptExtractor } from '../extractors/ts.js';
import { scipIndexToExtractionResults, scipPlusToExtractionResults } from '../protocol/scip-ingest.js';
import { createScipIndex, encodeScip, parseMoniker } from '../protocol/scip.js';

function sym(
  file: string,
  container: string | null,
  name: string,
  kind: ExtractionResult['symbols'][number]['kind'],
  spanStart: number,
  spanEnd: number,
  signature: string | null = null,
  doc: string | null = null,
) {
  return { id: symbolId(file, container, name, kind), kind, name, file, container, spanStart, spanEnd, signature, doc };
}

/** A store-shaped fixture: TS app + test file + a Go file (mixed-language export). */
function fixture(): ExtractionResult[] {
  const a = 'src/app.ts';
  const t = 'src/app.test.ts';
  const g = 'store/memstore.go';
  const appModule = sym(a, null, a, 'module', 1, 40);
  const store = sym(a, null, 'Store', 'class', 3, 30, null, 'the store');
  const replace = sym(a, 'Store', 'replaceFile', 'method', 10, 20, '(path: string)');
  const testModule = sym(t, null, t, 'module', 1, 60);
  const tb = sym(t, null, 'describe(Store works)', 'testblock', 5, 50);
  const goModule = sym(g, null, g, 'module', 1, 30);
  const memstore = sym(g, null, 'MemStore', 'struct', 3, 25);

  return [
    {
      file: a,
      symbols: [appModule, store, replace],
      edges: [
        { fromId: replace.id, toId: store.id, toName: 'Store', kind: 'references', resolved: true },
        { fromId: appModule.id, toId: null, toName: 'node:fs', kind: 'imports', resolved: false },
      ],
    },
    {
      file: t,
      symbols: [testModule, tb],
      edges: [
        { fromId: testModule.id, toId: appModule.id, toName: './app.js', kind: 'imports', resolved: true },
        { fromId: tb.id, toId: replace.id, toName: 'store.replaceFile', kind: 'calls', resolved: true },
      ],
    },
    { file: g, symbols: [goModule, memstore], edges: [] },
  ];
}

function seedStore(store: Store, repo: string, results: ExtractionResult[]): void {
  store.upsertRepo(repo, '/fixture');
  for (const r of results) store.replaceFile(repo, r.file, `h-${r.file}`, r.symbols, r.edges);
}

/** order-insensitive view: export reads rows back in store order, not extractor order */
function normalize(results: ExtractionResult[]) {
  return [...results]
    .sort((x, y) => (x.file < y.file ? -1 : 1))
    .map((r) => ({
      file: r.file,
      symbols: [...r.symbols].sort((x, y) => x.id.localeCompare(y.id)),
      edges: [...r.edges]
        .map((e) => `${e.fromId}|${e.toId}|${e.toName}|${e.kind}|${e.resolved}`)
        .sort(),
    }));
}

test('export → full ingest roundtrips store rows exactly (Step 4 export half)', () => {
  const store = new Store(':memory:');
  seedStore(store, 'fx', fixture());
  const { index, ext, files, skipped } = storeToScipPlus(store, 'fx');
  store.close();
  assert.equal(files, 3);
  assert.deepEqual(skipped, []);
  assert.deepEqual(normalize(scipPlusToExtractionResults(index, ext)), normalize(fixture()));
});

test('mixed-language export: per-document schemes, one librarian ToolInfo, path-sorted docs', () => {
  const store = new Store(':memory:');
  seedStore(store, 'fx', fixture());
  const { index } = storeToScipPlus(store, 'fx');
  store.close();
  assert.equal(index.metadata?.toolInfo?.name, 'librarian');
  assert.deepEqual(
    index.documents.map((d) => d.relativePath),
    ['src/app.test.ts', 'src/app.ts', 'store/memstore.go'],
  );
  for (const doc of index.documents) {
    const expected = doc.relativePath.endsWith('.go') ? 'librarian-go' : 'librarian-ts';
    for (const si of doc.symbols) {
      if (si.symbol.startsWith('local ')) continue;
      assert.equal(parseMoniker(si.symbol).scheme, expected, si.symbol);
    }
  }
});

test('files without a moniker scheme are reported, not silently dropped', () => {
  const store = new Store(':memory:');
  store.upsertRepo('fx', '/fixture');
  store.replaceFile('fx', 'lib/tasks.py', 'h-py', [sym('lib/tasks.py', null, 'lib/tasks.py', 'module', 1, 5)], []);
  const { files, skipped } = storeToScipPlus(store, 'fx');
  store.close();
  assert.equal(files, 0);
  assert.deepEqual(skipped, ['lib/tasks.py']);
});

test('importScip e2e: sidecar route reproduces the rows, re-import is a no-op', () => {
  const src = new Store(':memory:');
  seedStore(src, 'fx', fixture());
  const { index, ext } = storeToScipPlus(src, 'fx');

  const dir = mkdtempSync(join(tmpdir(), 'librarian-scip-import-'));
  try {
    writeFileSync(join(dir, 'fx.scip'), encodeScip(index));
    writeFileSync(join(dir, 'fx.scip-ext.json'), JSON.stringify(ext));
    const dst = new Store(':memory:');
    const report = importScip(dst, join(dir, 'fx.scip'), { repoName: 'fx', root: '/fixture' });
    assert.equal(report.degraded, false);
    assert.equal(report.filesIndexed, 3);
    assert.equal(report.symbols, 7);

    // ids are repo-namespaced on import; compare the shape per file
    for (const r of fixture()) {
      const got = dst.symbolsInFile(r.file, 'fx').map((s) => [s.kind, s.name, s.container, s.spanStart, s.spanEnd]);
      const want = [...r.symbols]
        .sort((x, y) => x.spanStart - y.spanStart)
        .map((s) => [s.kind, s.name, s.container, s.spanStart, s.spanEnd]);
      assert.deepEqual(got, want, r.file);
      const gotEdges = dst.edgesFromFile('fx', r.file).map((e) => [e.kind, e.toName, e.resolved]).sort();
      const wantEdges = r.edges.map((e) => [e.kind, e.toName, e.resolved]).sort();
      assert.deepEqual(gotEdges, wantEdges, r.file);
    }

    const again = importScip(dst, join(dir, 'fx.scip'), { repoName: 'fx', root: '/fixture' });
    assert.equal(again.filesIndexed, 0);
    assert.equal(again.filesUnchanged, 3);
    dst.close();
  } finally {
    src.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Degrade route — a synthetic index shaped like scip-python 0.6.x output:
// legacy `repeated int32` ranges, package-rooted monikers, Import roles,
// is_implementation relationships, parameters, a Test-role local.
// ---------------------------------------------------------------------------

const PY = 'scip-python python taskflow 0.1';

type DocumentInit = NonNullable<Parameters<typeof createScipIndex>[0]['documents']>[number];

function pythonishIndex(extraDocuments: DocumentInit[] = []) {
  return createScipIndex({
    metadata: {
      toolInfo: { name: 'scip-python', version: '0.6.6' },
      projectRoot: 'file:///py-src',
    },
    documents: [
      ...extraDocuments,
      {
        language: 'python',
        relativePath: 'taskflow/store.py',
        occurrences: [
          { symbol: `${PY} \`taskflow.store\`/__init__:`, symbolRoles: SymbolRole.Definition, range: [0, 0, 0] },
          { symbol: 'scip-python python numpy 1.26 `numpy`/__init__:', symbolRoles: SymbolRole.Import, range: [0, 7, 12] },
          { symbol: `${PY} \`taskflow.store\`/MemStore#`, symbolRoles: SymbolRole.Definition, range: [4, 6, 14], enclosingRange: [4, 0, 20, 0] },
          {
            symbol: `${PY} \`taskflow.store\`/MemStore#complete().`,
            symbolRoles: SymbolRole.Definition,
            range: [9, 8, 16],
            enclosingRange: [9, 4, 14, 0],
          },
          { symbol: `${PY} \`taskflow.store\`/MemStore#complete().(task)`, symbolRoles: SymbolRole.Definition, range: [9, 17, 21] },
          // a call-shaped reference (role 0) from inside complete() — degrades to `references`
          { symbol: `${PY} \`taskflow.util\`/log().`, symbolRoles: 0, range: [11, 8, 11] },
          // duplicated reference on another line — must dedupe
          { symbol: `${PY} \`taskflow.util\`/log().`, symbolRoles: 0, range: [12, 8, 11] },
          // Test-role local definition: partial testblock reconstruction
          { symbol: 'local 0', symbolRoles: SymbolRole.Definition | SymbolRole.Test, range: [16, 8, 20], enclosingRange: [16, 4, 19, 0] },
        ],
        // kind is left unset everywhere below (scip-python 0.6.x does that);
        // the ingest must fall back to the moniker grammar
        symbols: [
          { symbol: `${PY} \`taskflow.store\`/__init__:` },
          {
            symbol: `${PY} \`taskflow.store\`/MemStore#`,
            documentation: ['in-memory store'],
            relationships: [
              { symbol: `${PY} \`taskflow.base\`/Store#`, isImplementation: true },
            ],
          },
          {
            symbol: `${PY} \`taskflow.store\`/MemStore#complete().`,
            documentation: ['```python\ndef complete(self, id: int) -> None:\n```', 'mark a task done'],
          },
          { symbol: `${PY} \`taskflow.store\`/MemStore#complete().(task)` },
          { symbol: 'local 0', displayName: 'test_complete' },
        ],
      },
      {
        language: 'python',
        relativePath: 'taskflow/util.py',
        occurrences: [
          // `import taskflow.store` — no Import role, just a module-shaped reference
          { symbol: `${PY} \`taskflow.store\`/__init__:`, symbolRoles: SymbolRole.ReadAccess, range: [0, 7, 21] },
          { symbol: `${PY} \`taskflow.util\`/log().`, symbolRoles: SymbolRole.Definition, range: [2, 4, 7], enclosingRange: [2, 0, 5, 0] },
        ],
        // the kind-ful producer path must keep working alongside the fallback
        symbols: [{ symbol: `${PY} \`taskflow.util\`/log().`, kind: SymbolInformation_Kind.Function }],
      },
    ],
  });
}

test('degrade ingest maps an ext-less index per §4.5', () => {
  const { results, skippedSymbols } = scipIndexToExtractionResults(pythonishIndex());
  assert.equal(results.length, 2);
  const storePy = results[0];
  assert.equal(storePy.file, 'taskflow/store.py');

  // the parameter drops silently (by design, not a symbol) — nothing else skips
  assert.equal(skippedSymbols, 0);

  const byName = new Map(storePy.symbols.map((s) => [s.name, s]));
  const module = byName.get('taskflow/store.py')!;
  assert.equal(module.kind, 'module');
  const memstore = byName.get('MemStore')!;
  assert.deepEqual(
    [memstore.kind, memstore.container, memstore.spanStart, memstore.spanEnd, memstore.doc],
    ['class', null, 5, 20, 'in-memory store'],
  );
  const complete = byName.get('complete')!;
  assert.deepEqual(
    [complete.kind, complete.container, complete.spanStart, complete.spanEnd, complete.signature, complete.doc],
    ['method', 'MemStore', 10, 14, 'def complete(self, id: int) -> None:', 'mark a task done'],
  );
  const tb = byName.get('test_complete')!;
  assert.deepEqual([tb.kind, tb.container, tb.spanStart, tb.spanEnd], ['testblock', 'MemStore', 17, 19]);

  const utilLog = results[1].symbols.find((s) => s.name === 'log')!;
  const edges = storePy.edges.map((e) => [e.kind, e.toName, e.resolved, e.fromId === complete.id, e.toId]);
  assert.deepEqual(edges, [
    // import of an external package: unresolved, anchored at the module
    ['imports', 'numpy', false, false, null],
    // in-index reference resolves across documents; call-ness is lost → references
    ['references', 'log', true, true, utilLog.id],
    // is_implementation → extends; target not in the index → unresolved
    ['extends', 'Store', false, false, null],
  ]);

  // `import taskflow.store` in util.py: module-shaped reference → a RESOLVED
  // imports edge onto store.py's synthesized module row, like native imports
  const utilModule = results[1].symbols.find((s) => s.kind === 'module')!;
  const utilEdges = results[1].edges.map((e) => [e.kind, e.toName, e.resolved, e.fromId === utilModule.id, e.toId]);
  assert.deepEqual(utilEdges, [['imports', 'taskflow.store', true, true, module.id]]);
});

test('degrade importScip e2e flags the route and persists rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'librarian-scip-degrade-'));
  try {
    writeFileSync(join(dir, 'py.scip'), encodeScip(pythonishIndex()));
    const store = new Store(':memory:');
    const report = importScip(store, join(dir, 'py.scip'), { repoName: 'py' });
    assert.equal(report.degraded, true);
    assert.equal(report.skippedSymbols, 0);
    assert.equal(report.skippedNativeFiles, 0);
    assert.equal(report.filesSeen, 2);
    assert.equal(report.root, '/py-src');
    assert.ok(store.findSymbols('MemStore', 5, 'py').length === 1);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dispatch (§4.5 Step 5): degrade import skips native-claimed docs, index and import coexist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'librarian-scip-dispatch-'));
  try {
    // native side: a real TS file indexed by the native extractor
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'app.ts'), 'export function tsMain(): number { return 1; }\n');
    const store = new Store(':memory:');
    indexRepo(store, dir, { repoName: 'poly', extractors: [new TypeScriptExtractor()] });
    const nativeIds = store.findSymbols('tsMain', 5, 'poly').map((s) => s.id);
    assert.equal(nativeIds.length, 1);

    // external side: an ext-less .scip covering python AND the same TS file
    const index = pythonishIndex([
      {
        language: 'typescript',
        relativePath: 'src/app.ts',
        occurrences: [
          { symbol: 'scip-typescript npm app 0.1 `src/app`/tsMain().', symbolRoles: SymbolRole.Definition, range: [0, 16, 22] },
        ],
        symbols: [
          { symbol: 'scip-typescript npm app 0.1 `src/app`/tsMain().', kind: SymbolInformation_Kind.Function },
        ],
      },
    ]);
    writeFileSync(join(dir, 'py.scip'), encodeScip(index));

    const report = importScip(store, join(dir, 'py.scip'), { repoName: 'poly', root: dir });
    assert.equal(report.degraded, true);
    assert.equal(report.skippedNativeFiles, 1, 'the .ts document loses to the native extractor');
    assert.equal(report.filesSeen, 2, 'only the python documents ingest');
    assert.equal(store.findSymbols('MemStore', 5, 'poly').length, 1, 'python landed');
    assert.deepEqual(
      store.findSymbols('tsMain', 5, 'poly').map((s) => s.id),
      nativeIds,
      'native TS rows are untouched by the degrade import'
    );

    // jurisdiction: a reindex must not remove scip-imported files…
    const re = indexRepo(store, dir, { repoName: 'poly', extractors: [new TypeScriptExtractor()] });
    assert.equal(re.filesRemoved, 0);
    assert.equal(store.findSymbols('MemStore', 5, 'poly').length, 1);

    // …and a re-import must not remove native files (and is a no-op)
    const again = importScip(store, join(dir, 'py.scip'), { repoName: 'poly', root: dir });
    assert.equal(again.filesRemoved, 0);
    assert.equal(again.filesIndexed, 0);
    assert.equal(store.findSymbols('tsMain', 5, 'poly').length, 1);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
