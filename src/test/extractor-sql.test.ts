import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../store/store.js';
import { indexRepo } from '../app/index.js';
import { SqlExtractor } from '../extractors/sql.js';
import { parseUnifiedDiff } from '../core/diff.js';
import { retrieveForDiff } from '../core/retrieval.js';
import { assembleReviewPack } from '../core/contextpack.js';
import { runEval, loadGoldenFile } from '../app/eval.js';
import { PROTOCOL_NAME, PROTOCOL_VERSION, parseCapabilities } from '../protocol/scip.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sqlExtractorDir = join(repoRoot, 'sql-extractor');
const fixture = join(repoRoot, 'eval', 'fixtures', 'sql-taskflow');
const golden = join(repoRoot, 'eval', 'golden', 'sql-taskflow.json');

const hasGo = spawnSync('go', ['version'], { encoding: 'utf8' }).status === 0;

/**
 * Build the extractor binary once for the whole file — `go run` per test would
 * recompile each time. Tests skip (not fail) without a Go toolchain, mirroring
 * the extractor's own degrade-don't-block policy.
 */
let binary: string | null = null;
function builtBinary(): string {
  if (binary) return binary;
  const out = join(mkdtempSync(join(tmpdir(), 'librarian-sql-bin-')), 'librarian-sql-extractor');
  const res = spawnSync('go', ['build', '-o', out, '.'], { cwd: sqlExtractorDir, encoding: 'utf8' });
  assert.equal(res.status, 0, `go build failed: ${res.stderr}`);
  binary = out;
  return out;
}

function indexedFixture(): Store {
  process.env.LIBRARIAN_SQL_EXTRACTOR = builtBinary();
  const store = new Store(':memory:');
  indexRepo(store, fixture);
  return store;
}

test('sql fixture indexes with the object-kind taxonomy', { skip: !hasGo }, () => {
  const store = indexedFixture();
  const stats = store.stats();
  assert.equal(stats.byExtension.sql, 7, 'all fixture .sql files indexed');
  for (const kind of ['module', 'table', 'view', 'matview', 'function', 'procedure', 'trigger', 'index']) {
    assert.ok((stats.byKind[kind] ?? 0) > 0, `expected some ${kind} symbols`);
  }

  // a table is addressed as table.<name>
  const tasks = store.findSymbols('table.tasks')[0];
  assert.ok(tasks, 'table addressed as table.name');
  assert.equal(tasks.kind, 'table');
  assert.equal(tasks.file, 'schema/003_tasks.sql');
  store.close();
});

test('FK and view references resolve across files (blast radius)', { skip: !hasGo }, () => {
  const store = indexedFixture();
  const tasks = store.findSymbols('table.tasks')[0];
  const projects = store.findSymbols('table.projects')[0];
  const view = store.findSymbols('view.active_tasks')[0];

  // tasks (schema/003) has a FOREIGN KEY to projects (schema/002)
  assert.ok(
    store.edgesOf(tasks.id).out.some((e) => e.kind === 'references' && e.toId === projects.id && e.resolved),
    'cross-file FK resolves to the referenced table'
  );
  // the view's FROM/JOIN sources are out-edges; the table sees the view as in-edge
  assert.ok(
    store.edgesOf(view.id).out.some((e) => e.toId === tasks.id && e.resolved),
    'view references its base table'
  );
  assert.ok(
    store.edgesOf(tasks.id).in.some((e) => e.fromId === view.id),
    'the table sees the view that reads it'
  );
  store.close();
});

test('trigger references its relation and function; plpgsql body is mined', { skip: !hasGo }, () => {
  const store = indexedFixture();
  const trigger = store.findSymbols('trigger.tasks_audit')[0];
  const fn = store.findSymbols('function.log_task_change')[0];
  const tasks = store.findSymbols('table.tasks')[0];
  const events = store.findSymbols('table.task_events')[0];

  const out = store.edgesOf(trigger.id).out;
  assert.ok(out.some((e) => e.toId === tasks.id), 'trigger → ON relation');
  assert.ok(out.some((e) => e.toId === fn.id), 'trigger → EXECUTE FUNCTION target');

  // the plpgsql body INSERTs into task_events — mined via ParsePlPgSqlToJSON
  assert.ok(
    store.edgesOf(fn.id).out.some((e) => e.toId === events.id && e.resolved),
    'plpgsql body reference resolves'
  );
  store.close();
});

test('a diff on a table seeds retrieval and packs dependent objects', { skip: !hasGo }, () => {
  const store = indexedFixture();
  const users = store.findSymbols('table.users')[0];
  const diff = `--- a/schema/001_users.sql\n+++ b/schema/001_users.sql\n@@ -${users.spanStart},1 +${users.spanStart},1 @@\n-x\n+y\n`;
  const pack = retrieveForDiff(store, fixture, parseUnifiedDiff(diff), {});
  assert.ok(pack.seeds.some((s) => s.name === 'table.users'), 'span overlap seeds the table');

  const review = assembleReviewPack(diff, pack);
  const related = [...review.related, ...review.callers, ...review.callees];
  assert.ok(
    related.some((i) => i.name === 'table.tasks'),
    'a table with a FK to the changed table lands in the pack'
  );
  store.close();
});

test('eval baseline: the reference graph recovers the golden blast radius', { skip: !hasGo }, () => {
  const store = indexedFixture();
  const report = runEval(store, () => fixture, loadGoldenFile(golden), { hops: 2, budget: 8000 });
  // SQL references are lexically explicit, so the graph should fully recover the
  // curated blast radius. Lock the baseline; a regression drops recall here.
  assert.equal(report.aggregate.microRecall, 1, 'perfect micro recall on the sql golden');
  assert.equal(report.aggregate.perfectCases, report.aggregate.cases);
  store.close();
});

test('unparseable dialects degrade to the file module, parseable files still extract', { skip: !hasGo }, () => {
  const root = mkdtempSync(join(tmpdir(), 'librarian-sql-dialect-'));
  try {
    // MySQL-flavored DDL that libpg_query rejects
    writeFileSync(join(root, 'legacy.sql'), 'CREATE TABLE t (id INT) ENGINE=InnoDB AUTO_INCREMENT=3;\n');
    writeFileSync(join(root, 'ok.sql'), 'CREATE TABLE fine (id bigint);\n');
    process.env.LIBRARIAN_SQL_EXTRACTOR = builtBinary();
    const store = new Store(':memory:');
    indexRepo(store, root);
    const kinds = new Map(store.findSymbols('', 100).map((s) => [s.name, s.kind]));
    assert.equal(kinds.get('legacy.sql'), 'module', 'rejected file keeps its file-level anchor');
    assert.equal(kinds.get('table.fine'), 'table', 'other files still extract normally');
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('without a Go toolchain the claimed files degrade to file-level modules', () => {
  const root = mkdtempSync(join(tmpdir(), 'librarian-sql-degrade-'));
  writeFileSync(join(root, 'schema.sql'), 'CREATE TABLE t (id bigint);\n');
  const saved = { bin: process.env.LIBRARIAN_SQL_EXTRACTOR, path: process.env.PATH };
  delete process.env.LIBRARIAN_SQL_EXTRACTOR;
  process.env.PATH = '/nonexistent';
  try {
    const results = new SqlExtractor().extract(root, [join(root, 'schema.sql')]);
    assert.equal(results.length, 1);
    assert.deepEqual(
      results[0].symbols.map((s) => s.kind),
      ['module'],
      'file-level module symbol only'
    );
  } finally {
    if (saved.bin !== undefined) process.env.LIBRARIAN_SQL_EXTRACTOR = saved.bin;
    process.env.PATH = saved.path;
    rmSync(root, { recursive: true, force: true });
  }
});

test('--capabilities answers the handshake and announces the dialect', { skip: !hasGo }, () => {
  const res = spawnSync(builtBinary(), ['--capabilities'], { encoding: 'utf8', input: 'IGNORED' });
  assert.equal(res.status, 0);
  const caps = parseCapabilities(JSON.parse(res.stdout));
  assert.equal(caps.protocol, PROTOCOL_NAME);
  assert.equal(caps.protocolVersion, PROTOCOL_VERSION);
  assert.equal(caps.name, 'librarian-sql');
  assert.deepEqual(caps.extensions, ['.sql']);
  // dialect is an extra announcement field (issue #36); consumers ignore unknown
  // fields, so it must not break parseCapabilities — but it must be present raw.
  assert.equal((JSON.parse(res.stdout) as { dialect?: string }).dialect, 'postgresql');
});
