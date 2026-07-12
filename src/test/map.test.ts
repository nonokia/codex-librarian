import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.js';
import { indexRepo } from '../indexer.js';
import { buildMap, renderMapMarkdown } from '../map.js';

function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'librarian-map-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
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
console.log(external(add));
`
  );
  writeFileSync(join(root, 'scripts', 'tool.ts'), `export const answer = 42;\n`);
  return root;
}

test('index --include restricts to path prefixes (directory-boundary aware)', () => {
  const root = fixtureRepo();
  mkdirSync(join(root, 'src2'), { recursive: true });
  writeFileSync(join(root, 'src2', 'other.ts'), `export const x = 1;\n`);

  const store = new Store(':memory:');
  const report = indexRepo(store, root, { include: ['src'] });
  assert.equal(report.filesSeen, 2, 'only src/ files are seen');
  const paths = store.listFiles().map((f) => f.path);
  assert.deepEqual(paths, ['src/main.ts', 'src/util.ts']);
});

test('buildMap covers files, imports, symbol edges, and unresolved summary', () => {
  const root = fixtureRepo();
  const store = new Store(':memory:');
  indexRepo(store, root);
  const map = buildMap(store);

  assert.equal(map.files.length, 3);
  const main = map.files.find((f) => f.path === 'src/main.ts')!;
  assert.ok(main.symbols.some((s) => s.kind === 'method' && s.name === 'Derived.compute'));
  assert.ok(!main.symbols.some((s) => s.kind === 'module'), 'module rows are omitted');

  assert.deepEqual(map.imports, [{ from: 'src/main.ts', to: 'src/util.ts' }]);
  assert.ok(
    map.edges.some(
      (e) => e.from === 'Derived.compute' && e.to === 'add' && e.kind === 'calls'
    ),
    'symbol-level calls edge present'
  );
  assert.ok(!map.edges.some((e) => e.kind === 'imports'), 'imports stay file-level');
  assert.ok(map.unresolved.some((u) => u.name === 'external'), 'unresolved aggregated');
});

test('no-op reindex leaves the store untouched (self-index idempotence)', () => {
  const root = fixtureRepo();
  const store = new Store(':memory:');
  indexRepo(store, root);
  const before = store.getMeta('last_indexed_at');
  const report = indexRepo(store, root);
  assert.equal(report.filesIndexed, 0);
  assert.equal(store.getMeta('last_indexed_at'), before, 'meta untouched when nothing changed');
});

test('map is deterministic: reindex from scratch renders byte-identical output', () => {
  const root = fixtureRepo();
  const renders: string[] = [];
  const jsons: string[] = [];
  for (let i = 0; i < 2; i++) {
    const store = new Store(':memory:');
    indexRepo(store, root);
    const map = buildMap(store);
    renders.push(renderMapMarkdown(map));
    jsons.push(JSON.stringify(map));
    store.close();
  }
  assert.equal(renders[0], renders[1]);
  assert.equal(jsons[0], jsons[1]);
  assert.ok(!/\b(19|20)\d{11}\b/.test(renders[0]), 'no epoch timestamps leak into the map');
});
