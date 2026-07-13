import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SymbolRole } from '@scip-code/scip';
import { symbolId } from '../extractor.js';
import type { ExtractionResult } from '../extractor.js';
import { extractionResultsToScipPlus } from '../scip-emit.js';
import { scipPlusToExtractionResults } from '../scip-ingest.js';
import { isLocalSymbol } from '../scip.js';

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
  return {
    id: symbolId(file, container, name, kind),
    kind,
    name,
    file,
    container,
    spanStart,
    spanEnd,
    signature,
    doc,
  };
}

/**
 * The property Step 3 rests on: emit → ingest reproduces the rows exactly.
 * Covers the shapes the TS extractor actually produces — a module named by
 * its file, testblocks with dedupe suffixes and doc/signature, symbols nested
 * inside testblock containers (dotted, spaced names), and every edge kind
 * including unresolved and testblock-local endpoints.
 */
function fixture(): ExtractionResult[] {
  const a = 'src/app.ts';
  const t = 'src/app.test.ts';
  const appModule = sym(a, null, a, 'module', 1, 40);
  const store = sym(a, null, 'Store', 'class', 3, 30, null, 'the store');
  const replace = sym(a, 'Store', 'replaceFile', 'method', 10, 20, '(path: string)');
  const helper = sym(a, null, 'helper', 'function', 32, 40, '()');
  const base = sym(a, null, 'Base', 'interface', 1, 2);

  const testModule = sym(t, null, t, 'module', 1, 60);
  const describeTb = sym(t, null, 'describe(Store.replaceFile works)', 'testblock', 5, 50);
  const itTb = sym(
    t,
    'describe(Store.replaceFile works)',
    'it(replaces#2)',
    'testblock',
    10,
    20,
    '(t)',
    'dup-name testblock',
  );
  const inTbHelper = sym(t, 'describe(Store.replaceFile works)', 'localHelper', 'function', 25, 30);

  return [
    {
      file: a,
      symbols: [appModule, store, replace, helper, base],
      edges: [
        { fromId: store.id, toId: base.id, toName: 'Base', kind: 'extends', resolved: true },
        { fromId: replace.id, toId: helper.id, toName: 'helper', kind: 'calls', resolved: true },
        { fromId: helper.id, toId: null, toName: 'mkdirSync', kind: 'calls', resolved: false },
        { fromId: appModule.id, toId: null, toName: 'node:fs', kind: 'imports', resolved: false },
      ],
    },
    {
      file: t,
      symbols: [testModule, describeTb, itTb, inTbHelper],
      edges: [
        { fromId: testModule.id, toId: appModule.id, toName: './app.js', kind: 'imports', resolved: true },
        { fromId: itTb.id, toId: replace.id, toName: 'store.replaceFile', kind: 'calls', resolved: true },
        // an edge INTO a testblock (same document): a bare `let` inside the
        // describe body resolves to the enclosing testblock in the TS extractor
        { fromId: inTbHelper.id, toId: describeTb.id, toName: 'counter', kind: 'references', resolved: true },
        { fromId: describeTb.id, toId: store.id, toName: 'Store', kind: 'references', resolved: true },
      ],
    },
  ];
}

test('emit → ingest roundtrips rows exactly (the Step 3 property)', () => {
  const input = fixture();
  const { index, ext } = extractionResultsToScipPlus('librarian-ts', '/repo', input);
  assert.deepEqual(scipPlusToExtractionResults(index, ext), input);
});

test('testblocks project as locals with Test role and an enclosing symbol', () => {
  const { index } = extractionResultsToScipPlus('librarian-ts', '/repo', fixture());
  const testDoc = index.documents[1];
  const locals = testDoc.symbols.filter((s) => isLocalSymbol(s.symbol));
  assert.equal(locals.length, 2);
  // the nested it() encloses to the describe local; the describe to the module
  assert.ok(isLocalSymbol(locals[1].enclosingSymbol));
  assert.ok(locals[0].enclosingSymbol.includes('`src/app.test.ts`/'));
  for (const l of locals) {
    const def = testDoc.occurrences.find(
      (o) => o.symbol === l.symbol && o.symbolRoles & SymbolRole.Definition,
    );
    assert.ok(def && def.symbolRoles & SymbolRole.Test, l.symbol);
  }
});

test('extends edges project as is_implementation relationships, not occurrences', () => {
  const { index } = extractionResultsToScipPlus('librarian-ts', '/repo', fixture());
  const appDoc = index.documents[0];
  const store = appDoc.symbols.find((s) => s.displayName === 'Store');
  assert.ok(store);
  assert.equal(store.relationships.length, 1);
  assert.ok(store.relationships[0].isImplementation);
  assert.ok(store.relationships[0].symbol.endsWith('Base#'));
});
