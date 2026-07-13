import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store/store.js';
import { indexRepo } from '../app/index.js';

function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'librarian-fixture-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'util.ts'),
    `/** Adds two numbers. */
export function add(a: number, b: number): number { return a + b; }
export class Base { greet(): string { return 'hi'; } }
`
  );
  writeFileSync(
    join(root, 'src', 'main.ts'),
    `import { add, Base } from './util.ts';
export class Derived extends Base {
  compute(): number { return add(1, 2); }
}
export const triple = (n: number) => add(n, add(n, n));
export const handler = triple; // bare reference
console.log(external(handler));
`
  );
  return root;
}

test('indexRepo extracts symbols, edges, and resolves across files', () => {
  const root = fixtureRepo();
  const store = new Store(':memory:');
  const report = indexRepo(store, root);

  assert.equal(report.filesSeen, 2);
  assert.equal(report.filesIndexed, 2);

  const add = store.findSymbols('add')[0];
  assert.ok(add, 'add symbol exists');
  assert.equal(add.kind, 'function');
  assert.equal(add.file, 'src/util.ts');
  assert.match(add.doc ?? '', /Adds two numbers/);

  const triple = store.findSymbols('triple')[0];
  assert.equal(triple.kind, 'function', 'arrow-function const is a function');

  // calls edge: Derived.compute -> add (cross-file, type-resolved)
  const compute = store.findSymbols('compute')[0];
  const outEdges = store.edgesOf(compute.id).out;
  assert.ok(
    outEdges.some((e) => e.kind === 'calls' && e.toId === add.id && e.resolved),
    'compute calls add resolved'
  );

  // extends edge: Derived -> Base
  const derived = store.findSymbols('Derived')[0];
  const base = store.findSymbols('Base')[0];
  assert.ok(
    store.edgesOf(derived.id).out.some((e) => e.kind === 'extends' && e.toId === base.id),
    'Derived extends Base'
  );

  // imports edge: main.ts module -> util.ts module
  const mainMod = store.symbolsInFile('src/main.ts').find((s) => s.kind === 'module')!;
  const utilMod = store.symbolsInFile('src/util.ts').find((s) => s.kind === 'module')!;
  assert.ok(
    store.edgesOf(mainMod.id).out.some((e) => e.kind === 'imports' && e.toId === utilMod.id),
    'main imports util'
  );

  // bare reference edge: handler -> triple
  const handler = store.findSymbols('handler')[0];
  assert.ok(
    store.edgesOf(handler.id).out.some((e) => e.kind === 'references' && e.toId === triple.id),
    'handler references triple'
  );

  // unresolved call kept with flag (architecture §8 risk 2)
  assert.ok(report.unresolvedEdges > 0, 'unresolved edges are kept');

  // k-hop: neighborhood of add reaches compute and triple (incoming calls)
  const hood = store.neighborhood(add.id, 2, 100);
  const names = hood.map((n) => n.name);
  assert.ok(names.includes('compute') && names.includes('triple'), `k-hop finds callers: ${names}`);

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('test blocks become symbols so test edges are block-scoped, not module-scoped', () => {
  const root = fixtureRepo();
  writeFileSync(
    join(root, 'src', 'util.test.ts'),
    `import { add } from './util.ts';
declare function describe(t: string, f: () => void): void;
declare function it(t: string, f: () => void): void;
describe('add', () => {
  it('sums two numbers', () => {
    add(1, 2);
  });
  it('sums two numbers', () => {
    add(3, 4);
  });
});
`
  );
  const store = new Store(':memory:');
  indexRepo(store, root);

  const blocks = store.symbolsInFile('src/util.test.ts').filter((s) => s.kind === 'testblock');
  const names = blocks.map((b) => b.name).sort();
  assert.deepEqual(names, ['describe(add)', 'it(sums two numbers)', 'it(sums two numbers)#2']);
  const it1 = blocks.find((b) => b.name === 'it(sums two numbers)')!;
  assert.equal(it1.container, 'describe(add)');

  const add = store.findSymbols('add').find((s) => s.kind === 'function')!;
  const callers = store.edgesOf(add.id).in.filter((e) => e.kind === 'calls');
  assert.ok(
    callers.every((e) => e.fromId !== undefined) &&
      callers.some((e) => e.fromId === it1.id),
    'call edge originates from the it-block, not the file module'
  );
  assert.ok(
    it1.spanEnd - it1.spanStart <= 3,
    'block span is small enough to pack into a context budget'
  );

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('re-index is incremental: unchanged files are not rewritten', () => {
  const root = fixtureRepo();
  const store = new Store(':memory:');
  indexRepo(store, root);

  const second = indexRepo(store, root);
  assert.equal(second.filesIndexed, 0, 'nothing changed, nothing rewritten');

  writeFileSync(join(root, 'src', 'util.ts'), `export function add(a: number, b: number) { return a + b; }`);
  const third = indexRepo(store, root);
  assert.equal(third.filesIndexed, 1, 'only the changed file is rewritten');
  assert.ok(store.findSymbols('Base').length === 0, 'stale symbols of changed file removed');

  store.close();
  rmSync(root, { recursive: true, force: true });
});
