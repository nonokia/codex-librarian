/**
 * Cross-repo import resolution (#27): `librarian link` over the committed
 * fixture pair (eval/fixtures/cross-repo) — a library repo published as
 * `@acme/core` and the app repo that imports it by package name.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../store/store.js';
import { indexRepo } from '../app/index.js';
import { link, loadLinkMap, parseLinkMap, unlink, type LinkMap } from '../app/link.js';
import { parseUnifiedDiff } from '../core/diff.js';
import { retrieveForDiff } from '../core/retrieval.js';
import { assembleReviewPack } from '../core/contextpack.js';
import { loadGoldenFile, runEval } from '../app/eval.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixture = join(repoRoot, 'eval', 'fixtures', 'cross-repo');
const coreRoot = join(fixture, 'acme-core');
const appRoot = join(fixture, 'acme-app');

/** Both fixture repos in one db (#11), extracted but not yet linked. */
function indexedPair(dbPath = ':memory:'): Store {
  const store = new Store(dbPath);
  indexRepo(store, coreRoot, { repoName: 'acme-core' });
  indexRepo(store, appRoot, { repoName: 'acme-app' });
  return store;
}

const MAP: LinkMap = { packages: [{ package: '@acme/core', repo: 'acme-core', entry: 'src/index.ts' }] };
const roots = (repo: string) => (repo === 'acme-core' ? coreRoot : appRoot);

/** A diff against acme-core's `overdue` — the library change the app repo must feel. */
const OVERDUE_DIFF = `--- a/src/task.ts
+++ b/src/task.ts
@@ -14,3 +14,3 @@
 export function overdue(task: Task, now: number): boolean {
-  return !task.done && task.dueAt < now;
+  return !task.done && task.dueAt <= now;
 }
`;

test('the extractor names external imports AND their use sites by package', () => {
  const store = indexedPair();
  const open = store.unresolvedEdges('acme-app').map((e) => `${e.fromFile} ${e.kind} ${e.toName}`);

  // the import itself
  assert.ok(open.includes('src/service.ts imports @acme/core#createTask'), JSON.stringify(open));
  // the local alias is carried on the import edge…
  assert.ok(open.includes('src/report.ts imports @acme/core#overdue as isOverdue'), JSON.stringify(open));
  // …and the call site that uses it is named by the EXPORTED name, not the alias
  assert.ok(open.includes('src/report.ts calls @acme/core#overdue'), JSON.stringify(open));
  // undeclared packages are named the same way — naming is not resolving
  assert.ok(open.includes('src/service.ts calls node:crypto#randomUUID'), JSON.stringify(open));
  // a method call carries only its bare name: nothing bound it, so nothing can link it
  assert.ok(open.includes('src/service.ts calls add'), JSON.stringify(open));
  store.close();
});

test('a method call that shares an export name is never linked', () => {
  // `seen.add(v)` and an imported `add` collide on the bare name. The extractor
  // only qualifies the one the checker traced to the import, so the method call
  // has nothing to link against — the false edge cannot be constructed.
  const libRoot = mkdtempSync(join(tmpdir(), 'librarian-math-'));
  mkdirSync(join(libRoot, 'src'), { recursive: true });
  writeFileSync(join(libRoot, 'src', 'math.ts'), 'export function add(a: number, b: number): number { return a + b; }\n');

  const useRoot = mkdtempSync(join(tmpdir(), 'librarian-tally-'));
  mkdirSync(join(useRoot, 'src'), { recursive: true });
  writeFileSync(
    join(useRoot, 'src', 'tally.ts'),
    `import { add } from '@acme/math';
export function collect(values: number[]): Set<number> {
  const seen = new Set<number>();
  for (const v of values) seen.add(v);
  return seen;
}
export function total(a: number, b: number): number { return add(a, b); }
`
  );

  const store = new Store(':memory:');
  indexRepo(store, libRoot, { repoName: 'acme-math' });
  indexRepo(store, useRoot, { repoName: 'tally-app' });
  link(store, { packages: [{ package: '@acme/math', repo: 'acme-math' }] });

  const calls = store.crossRepoEdges().filter((e) => e.kind === 'calls').map((e) => e.from.name);
  assert.deepEqual(calls, ['total'], 'only the real call links; `collect` calls Set.add, not @acme/math#add');
  store.close();
});

test('without a declaration nothing is linked (no false edges, no degrade)', () => {
  const store = indexedPair();
  const before = store.stats();

  assert.equal(store.countCrossRepoEdges(), 0);
  // an empty declaration is still a declaration: it links nothing
  const report = link(store, { packages: [] });
  assert.equal(report.newlyResolved, 0);
  assert.equal(store.countCrossRepoEdges(), 0);
  assert.deepEqual(store.stats(), before);
  store.close();
});

test('link resolves cross-repo calls through the declared package', () => {
  const store = indexedPair();
  const report = link(store, MAP);

  assert.equal(report.ambiguous.length, 0, JSON.stringify(report.ambiguous));
  assert.equal(report.missingTargets.length, 0, JSON.stringify(report.missingTargets));
  assert.equal(report.newlyResolved, report.crossRepoEdges);
  assert.equal(report.byPackage['@acme/core'], report.newlyResolved);

  const cross = store.crossRepoEdges();
  const calls = cross
    .filter((e) => e.kind === 'calls')
    .map((e) => `${e.from.repo}:${e.from.name} → ${e.to.repo}:${e.to.name}`);
  assert.ok(calls.includes('acme-app:addTask → acme-core:createTask'), JSON.stringify(calls));
  assert.ok(calls.includes('acme-app:overdueCount → acme-core:overdue'), JSON.stringify(calls));
  // the aliased call site (`isOverdue`) binds back to the exported name
  assert.ok(calls.includes('acme-app:overdueTitles → acme-core:overdue'), JSON.stringify(calls));

  // the declared entry file resolves the bare `imports "@acme/core"` edge
  const entryImports = cross.filter((e) => e.kind === 'imports' && e.to.file === 'src/index.ts');
  assert.ok(entryImports.length >= 1, 'module-level import resolves to the entry module');

  // an undeclared package stays exactly as extracted
  const stillUnresolved = store.unresolvedEdges('acme-app').map((e) => e.toName);
  assert.ok(stillUnresolved.includes('node:crypto'), 'undeclared package is left alone');
  assert.ok(stillUnresolved.includes('node:crypto#randomUUID'), 'its call sites stay unresolved');
  // methods need type resolution to bind — they are not name-matched
  assert.ok(stillUnresolved.includes('add'), 'a method call is not linked by name');
  store.close();
});

test("a diff in the library repo packs the app repo's callers (#27 acceptance)", () => {
  const store = indexedPair();
  link(store, MAP);

  const pack = assembleReviewPack(
    OVERDUE_DIFF,
    retrieveForDiff(store, roots, parseUnifiedDiff(OVERDUE_DIFF), {
      hops: 2,
      budget: 8000,
      withSource: true,
      repo: 'acme-core',
    })
  );

  const callers = pack.callers.map((i) => `${i.repo}:${i.name}`);
  assert.ok(callers.includes('acme-app:overdueCount'), JSON.stringify(callers));
  assert.ok(callers.includes('acme-app:overdueTitles'), JSON.stringify(callers));
  assert.ok(callers.includes('acme-core:MemStore.overdueTasks'), JSON.stringify(callers));
  // cross-repo items carry their own repo's source, read through the repos table
  const app = pack.callers.find((i) => i.repo === 'acme-app')!;
  assert.ok(app.text && app.text.length > 0, 'source of a cross-repo item is read from its own root');
  store.close();
});

test('the golden set measures the difference: unlinked 6/14, linked 14/14', () => {
  const store = indexedPair();
  const cases = loadGoldenFile(join(repoRoot, 'eval', 'golden', 'cross-repo.json'));

  const before = runEval(store, roots, cases, { hops: 2, budget: 8000 });
  assert.equal(before.aggregate.totalMatched, 6, JSON.stringify(before.aggregate));

  link(store, MAP);
  const after = runEval(store, roots, cases, { hops: 2, budget: 8000 });
  assert.equal(after.aggregate.totalMatched, 14, JSON.stringify(after.aggregate));
  assert.equal(after.aggregate.microRecall, 1);
  store.close();
});

test('link is idempotent, and --clear restores the edges as extracted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'librarian-link-'));
  const dbPath = join(dir, 'x.db');
  const store = indexedPair(dbPath);
  const edges = () => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare('SELECT from_id, to_id, to_name, kind, resolved FROM edges ORDER BY from_id, to_id, to_name, kind')
      .all();
    db.close();
    return JSON.stringify(rows);
  };

  const extracted = edges();
  const first = link(store, MAP);
  assert.ok(first.newlyResolved > 0);

  const second = link(store, MAP);
  assert.equal(second.newlyResolved, 0, 'a second run resolves nothing new');
  assert.equal(second.crossRepoEdges, first.crossRepoEdges);
  assert.notEqual(edges(), extracted);

  const cleared = unlink(store);
  assert.equal(cleared.unlinked, first.crossRepoEdges);
  assert.equal(cleared.crossRepoEdges, 0);
  assert.equal(edges(), extracted, 'clear restores the exact rows the extractor emitted');
  store.close();
});

test('an ambiguous name is refused, not guessed', () => {
  // a library that declares `helper` twice at module scope: nothing in the store
  // can say which one an importer meant — so neither is linked
  const libRoot = mkdtempSync(join(tmpdir(), 'librarian-lib-'));
  mkdirSync(join(libRoot, 'src'), { recursive: true });
  writeFileSync(join(libRoot, 'src', 'a.ts'), 'export function helper(): number { return 1; }\n');
  writeFileSync(join(libRoot, 'src', 'b.ts'), 'export function helper(): string { return "b"; }\n');
  writeFileSync(join(libRoot, 'src', 'only.ts'), 'export function only(): number { return 2; }\n');

  const useRoot = mkdtempSync(join(tmpdir(), 'librarian-use-'));
  mkdirSync(join(useRoot, 'src'), { recursive: true });
  writeFileSync(
    join(useRoot, 'src', 'app.ts'),
    `import { helper, only, missing } from '@dup/lib';
export function run(): number { return helper() + only() + missing(); }
`
  );

  const store = new Store(':memory:');
  indexRepo(store, libRoot, { repoName: 'dup-lib' });
  indexRepo(store, useRoot, { repoName: 'dup-app' });
  const report = link(store, { packages: [{ package: '@dup/lib', repo: 'dup-lib' }] });

  assert.deepEqual(
    report.ambiguous.map((a) => `${a.package}#${a.name}`),
    ['@dup/lib#helper']
  );
  assert.deepEqual(
    report.missingTargets.map((m) => `${m.package}#${m.name}`),
    ['@dup/lib#missing']
  );
  // `only` is unambiguous: the binding edge and the call site both link
  const cross = store.crossRepoEdges();
  assert.deepEqual(
    cross.filter((e) => e.kind === 'calls').map((e) => `${e.from.name} → ${e.to.name}`),
    ['run → only']
  );
  assert.ok(
    store.unresolvedEdges('dup-app').some((e) => e.kind === 'calls' && e.toName === '@dup/lib#helper'),
    'the ambiguous call stays unresolved'
  );
  store.close();
});

test('a declaration pointing at an unindexed repo fails loudly', () => {
  const store = indexedPair();
  assert.throws(
    () => link(store, { packages: [{ package: '@acme/core', repo: 'not-indexed' }] }),
    /not-indexed/
  );
  store.close();
});

test('the link map is validated, and the fixture map parses', () => {
  assert.throws(() => parseLinkMap({}), /packages/);
  assert.throws(() => parseLinkMap({ packages: [{ repo: 'x' }] }), /package must be a non-empty string/);
  assert.throws(() => parseLinkMap({ packages: [{ package: '@a/b' }] }), /repo must be a non-empty string/);
  assert.throws(
    () => parseLinkMap({ packages: [{ package: '@a/b', repo: 'x' }, { package: '@a/b', repo: 'y' }] }),
    /declared twice/
  );
  assert.deepEqual(loadLinkMap(join(fixture, 'links.json')), MAP);
});
