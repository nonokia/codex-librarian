import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.js';
import { indexRepo } from '../indexer.js';
import { parseUnifiedDiff } from '../diff.js';
import { retrieveForDiff, seedsFromDiff } from '../retrieval.js';
import { runEval, type GoldenCase } from '../eval.js';

test('parseUnifiedDiff extracts new-side ranges per file', () => {
  const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,3 +12,4 @@ context
 line
+added
 line
@@ -30 +40 @@
-x
+y
diff --git a/src/gone.ts b/src/gone.ts
--- a/src/gone.ts
+++ /dev/null
@@ -1,5 +0,0 @@
-dead
`;
  const hunks = parseUnifiedDiff(diff);
  assert.deepEqual(hunks, [
    { file: 'src/a.ts', ranges: [[12, 15], [40, 40]] },
    { file: 'src/gone.ts', ranges: [[1, 1]] },
  ]);
});

function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'librarian-eval-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'core.ts'),
    `export function load(): number { return 1; }
export function save(n: number): void { void n; }
`
  );
  writeFileSync(
    join(root, 'src', 'app.ts'),
    `import { load, save } from './core.ts';
export function run(): void { save(load()); }
`
  );
  return root;
}

test('seedsFromDiff: span overlap, module fallback, unknown file', () => {
  const root = fixtureRepo();
  const store = new Store(':memory:');
  indexRepo(store, root);

  const overlap = seedsFromDiff(store, [{ file: 'src/core.ts', ranges: [[1, 1]] }]);
  assert.deepEqual(overlap.seeds.map((s) => s.symbol.name), ['load']);
  assert.equal(overlap.seeds[0].via, 'span-overlap');

  const fallback = seedsFromDiff(store, [{ file: 'src/core.ts', ranges: [[999, 999]] }]);
  assert.equal(fallback.seeds[0].via, 'file-fallback');
  assert.equal(fallback.seeds[0].symbol.kind, 'module');

  const unknown = seedsFromDiff(store, [{ file: 'nope.ts', ranges: [[1, 1]] }]);
  assert.deepEqual(unknown.unknownFiles, ['nope.ts']);

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('retrieveForDiff finds callers of a changed function; budget elides', () => {
  const root = fixtureRepo();
  const store = new Store(':memory:');
  indexRepo(store, root);

  const hunks = [{ file: 'src/core.ts', ranges: [[1, 1]] as [number, number][] }];
  const pack = retrieveForDiff(store, root, hunks, { hops: 2, budget: 8000 });
  assert.ok(pack.items.some((i) => i.name === 'run'), 'caller `run` retrieved');

  const tiny = retrieveForDiff(store, root, hunks, { hops: 2, budget: 1 });
  assert.equal(tiny.items.length, 0);
  assert.ok(tiny.elided.length > 0, 'over-budget items land in elided');

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('runEval scores golden cases (diff and target styles)', () => {
  const root = fixtureRepo();
  const store = new Store(':memory:');
  indexRepo(store, root);

  const cases: GoldenCase[] = [
    {
      id: 'diff-style',
      title: 'changing load should surface run',
      diff: `--- a/src/core.ts\n+++ b/src/core.ts\n@@ -1,1 +1,1 @@\n-x\n+y\n`,
      expected: [{ file: 'src/app.ts', symbol: 'run' }],
    },
    {
      id: 'target-style',
      title: 'changing save should surface run',
      target: { file: 'src/core.ts', symbol: 'save' },
      expected: [
        { file: 'src/app.ts', symbol: 'run' },
        { file: 'src/app.ts', symbol: 'doesNotExist' },
      ],
    },
  ];
  const report = runEval(store, root, cases, { hops: 2, budget: 8000 });
  assert.equal(report.cases[0].recall, 1);
  assert.equal(report.cases[1].recall, 0.5);
  assert.deepEqual(report.cases[1].missed, [{ file: 'src/app.ts', symbol: 'doesNotExist' }]);
  assert.equal(report.aggregate.totalExpected, 3);
  assert.equal(report.aggregate.totalMatched, 2);
  assert.equal(report.aggregate.perfectCases, 1);

  store.close();
  rmSync(root, { recursive: true, force: true });
});
