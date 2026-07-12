/** Multi-repo store tests (#11): two repos in one db, cross-repo queries. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../store.js';
import { indexRepo } from '../indexer.js';
import { parseUnifiedDiff } from '../diff.js';
import { retrieveForDiff } from '../retrieval.js';
import { buildMap, renderMapMarkdown } from '../map.js';

/** Two repos deliberately sharing the same path (src/index.ts) and a symbol name. */
function twoRepos(): { alphaRoot: string; betaRoot: string } {
  const alphaRoot = mkdtempSync(join(tmpdir(), 'librarian-alpha-'));
  mkdirSync(join(alphaRoot, 'src'), { recursive: true });
  writeFileSync(
    join(alphaRoot, 'src', 'index.ts'),
    `export function greet(name: string): string { return 'alpha ' + name; }
export function main(): string { return greet('a'); }
`
  );
  const betaRoot = mkdtempSync(join(tmpdir(), 'librarian-beta-'));
  mkdirSync(join(betaRoot, 'src'), { recursive: true });
  writeFileSync(
    join(betaRoot, 'src', 'index.ts'),
    `export function greet(who: string): string { return 'beta ' + who; }
export const shout = (who: string) => greet(who).toUpperCase();
`
  );
  return { alphaRoot, betaRoot };
}

test('two repos share one db without path or symbol-id collisions', () => {
  const { alphaRoot, betaRoot } = twoRepos();
  const store = new Store(':memory:');
  const a = indexRepo(store, alphaRoot, { repoName: 'alpha' });
  const b = indexRepo(store, betaRoot, { repoName: 'beta' });
  assert.equal(a.repo, 'alpha');
  assert.equal(b.repo, 'beta');

  // same relative path in both repos → two files rows, not one overwrite
  const stats = store.stats();
  assert.equal(stats.files, 2);
  assert.deepEqual(
    store.listRepos().map((r) => r.name),
    ['alpha', 'beta']
  );
  assert.equal(stats.byRepo.alpha.files, 1);
  assert.equal(stats.byRepo.beta.files, 1);

  // same identity hash input (file::container::name::kind) → distinct ids per repo
  const greets = store.findSymbols('greet');
  assert.equal(greets.length, 2, 'cross-repo search sees both greets');
  assert.notEqual(greets[0].id, greets[1].id);
  assert.deepEqual(greets.map((s) => s.repo).sort(), ['alpha', 'beta']);

  // repo filter narrows
  const onlyBeta = store.findSymbols('greet', 20, 'beta');
  assert.equal(onlyBeta.length, 1);
  assert.equal(onlyBeta[0].repo, 'beta');

  // graph edges stay inside their repo: alpha's main calls alpha's greet
  const alphaGreet = store.findSymbols('greet', 20, 'alpha')[0];
  const main = store.findSymbols('main', 20, 'alpha')[0];
  assert.ok(
    store.edgesOf(main.id).out.some((e) => e.kind === 'calls' && e.toId === alphaGreet.id),
    'main calls alpha greet'
  );
  const neighbors = store.neighborhood(alphaGreet.id, 2, 50);
  assert.ok(neighbors.every((n) => n.repo === 'alpha'), 'neighborhood never crosses repos');
});

test('single-repo flow keeps working without --repo-name (basename default)', () => {
  const { alphaRoot } = twoRepos();
  const store = new Store(':memory:');
  const report = indexRepo(store, alphaRoot);
  assert.equal(report.repo, alphaRoot.split('/').pop());
  assert.equal(store.listRepos().length, 1);
  assert.equal(store.findSymbols('greet').length, 1);
});

test('retrieval scopes seeds by repo and reads source from the right root', () => {
  const { alphaRoot, betaRoot } = twoRepos();
  const store = new Store(':memory:');
  indexRepo(store, alphaRoot, { repoName: 'alpha' });
  indexRepo(store, betaRoot, { repoName: 'beta' });
  const rootFor = (repo: string) =>
    repo === 'alpha' ? alphaRoot : repo === 'beta' ? betaRoot : null;

  const diff = `--- a/src/index.ts
+++ b/src/index.ts
@@ -1,2 +1,2 @@
-export function greet(who: string): string { return 'beta ' + who; }
+export function greet(who: string): string { return 'BETA ' + who; }
`;
  const pack = retrieveForDiff(store, rootFor, parseUnifiedDiff(diff), {
    withSource: true,
    repo: 'beta',
  });
  assert.ok(pack.seeds.length > 0, 'diff seeds resolve');
  assert.ok(pack.seeds.every((s) => s.repo === 'beta'), 'repo option scopes seeds');
  const withText = [...pack.seeds, ...pack.items].filter((i) => i.text !== undefined);
  assert.ok(withText.length > 0);
  assert.ok(
    withText.some((i) => i.text!.includes("'beta '")),
    'source text read from the beta checkout'
  );
  assert.ok(
    withText.every((i) => !i.text!.includes("'alpha '")),
    'alpha source never leaks into a beta pack'
  );
});

test('map prefixes paths with the repo only when the db is multi-repo', () => {
  const { alphaRoot, betaRoot } = twoRepos();
  const single = new Store(':memory:');
  indexRepo(single, alphaRoot, { repoName: 'alpha' });
  const singleMap = renderMapMarkdown(buildMap(single));
  assert.match(singleMap, /### src\/index\.ts/, 'single repo: no prefix');
  assert.doesNotMatch(singleMap, /alpha:src\//);
  assert.doesNotMatch(singleMap, /- repos:/);

  const multi = new Store(':memory:');
  indexRepo(multi, alphaRoot, { repoName: 'alpha' });
  indexRepo(multi, betaRoot, { repoName: 'beta' });
  const multiMap = renderMapMarkdown(buildMap(multi));
  assert.match(multiMap, /### alpha:src\/index\.ts/);
  assert.match(multiMap, /### beta:src\/index\.ts/);
  assert.match(multiMap, /- repos: alpha \(files=1, symbols=\d+\), beta \(files=1, symbols=\d+\)/);
});

test('a pre-v2 (single-repo) db is rejected with re-index guidance', () => {
  const dir = mkdtempSync(join(tmpdir(), 'librarian-v1-'));
  const dbPath = join(dir, 'v1.db');
  // fabricate the v1 shape: files keyed by path alone, no repo column
  const raw = new DatabaseSync(dbPath);
  raw.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE files (path TEXT PRIMARY KEY, hash TEXT NOT NULL, indexed_at INTEGER NOT NULL);`);
  raw.close();
  assert.throws(() => new Store(dbPath), /incompatible index schema.*re-run/s);
});
