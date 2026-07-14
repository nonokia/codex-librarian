import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store/store.js';
import { indexRepo } from '../app/index.js';

/**
 * Fixture: two files with intra- and inter-file resolved edges plus an
 * unresolved external call, so the collapse can be checked against exact
 * per-file / per-kind counts.
 */
function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'librarian-collapse-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'util.ts'),
    `export function add(a: number, b: number): number { return a + b; }
export class Base { greet(): string { return 'hi'; } }
`
  );
  writeFileSync(
    join(root, 'src', 'main.ts'),
    `import { add, Base } from './util.ts';
export class Derived extends Base {
  compute(): number { return add(1, 2); }
}
export function run(): void { external(add); }
`
  );
  return root;
}

test('symbolCountsByFile aggregates per file and matches the raw rows', () => {
  const store = new Store(':memory:');
  indexRepo(store, fixtureRepo());

  const counts = store.symbolCountsByFile();
  const byFile = new Map(counts.map((c) => [c.file, c.symbols]));
  // every file with symbols appears exactly once
  assert.equal(counts.length, new Set(counts.map((c) => c.file)).size);
  // counts equal the actual number of symbol rows in that file
  for (const c of counts) {
    assert.equal(c.symbols, store.symbolsInFile(c.file).length, `count for ${c.file}`);
  }
  assert.ok(byFile.get('src/util.ts')! >= 2, 'util.ts has at least add + Base');
});

test('symbolCountsByFile can scope to one repo', () => {
  const store = new Store(':memory:');
  indexRepo(store, fixtureRepo());
  const repo = store.listRepos()[0].name;
  const scoped = store.symbolCountsByFile(repo);
  assert.equal(scoped.length, store.symbolCountsByFile().length);
  assert.equal(store.symbolCountsByFile('no-such-repo').length, 0);
});

test('collapsedEdges rolls symbol edges up to file granularity, conserving totals', () => {
  const store = new Store(':memory:');
  indexRepo(store, fixtureRepo());

  const bundles = store.collapsedEdges();
  const stats = store.stats();

  const resolvedTotal = bundles
    .filter((b) => b.resolved)
    .reduce((a, b) => a + b.count, 0);
  const unresolvedTotal = bundles
    .filter((b) => !b.resolved)
    .reduce((a, b) => a + b.count, 0);

  // collapsing conserves edge counts: no edge dropped or double-counted
  assert.equal(resolvedTotal, stats.edges - stats.unresolvedEdges, 'resolved conserved');
  assert.equal(unresolvedTotal, stats.unresolvedEdges, 'unresolved conserved');

  // resolved bundles carry a target file; unresolved never do
  for (const b of bundles) {
    if (b.resolved) assert.ok(b.toFile !== null, 'resolved bundle has a target file');
    else assert.equal(b.toFile, null, 'unresolved bundle has no target file');
  }

  // a bundle is unique per (from,to,kind,resolved) — the group key
  const keys = bundles.map((b) => `${b.fromFile}|${b.toFile}|${b.kind}|${b.resolved}`);
  assert.equal(keys.length, new Set(keys).size, 'bundles are unique per group key');

  // main.ts → util.ts has a resolved calls edge (compute/run call add)
  const mainToUtil = bundles.find(
    (b) => b.fromFile === 'src/main.ts' && b.toFile === 'src/util.ts' && b.kind === 'calls'
  );
  assert.ok(mainToUtil && mainToUtil.count >= 1, 'main→util calls bundle exists');

  // the unresolved external() call survives as an unresolved bundle
  assert.ok(
    bundles.some((b) => !b.resolved && b.fromFile === 'src/main.ts'),
    'unresolved external call is kept as an unresolved bundle'
  );
});
