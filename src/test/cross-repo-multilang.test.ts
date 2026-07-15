/**
 * Cross-repo import resolution for the non-TS extractors (#35): the §8.1
 * binding convention (`<specifier>#<imported>`), extended from the TS extractor
 * to Go / Python / PHP so `librarian link` resolves cross-repo edges in an index
 * that contains no TypeScript at all. Python has a committed fixture pair
 * (eval/fixtures/cross-repo-py) measured by a golden set; Go and PHP are proven
 * on small inline pairs (a full Go fixture would need a module cache).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../store/store.js';
import { indexRepo } from '../app/index.js';
import { link } from '../app/link.js';
import { loadGoldenFile, runEval } from '../app/eval.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const hasPython = spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0;
const hasGo = spawnSync('go', ['version'], { encoding: 'utf8' }).status === 0;
const hasPhp = spawnSync('php', ['--version'], { encoding: 'utf8' }).status === 0;

// ---- Python: the committed, golden-measured fixture pair ----

const pyFixture = join(repoRoot, 'eval', 'fixtures', 'cross-repo-py');
const pyCore = join(pyFixture, 'py-core');
const pyApp = join(pyFixture, 'py-app');
const pyRoots = (repo: string) => (repo === 'pycore' ? pyCore : pyApp);
const PY_MAP = { packages: [{ package: 'taskcore', repo: 'pycore', entry: 'taskcore/__init__.py' }] };

function indexedPyPair(): Store {
  const store = new Store(':memory:');
  indexRepo(store, pyCore, { repoName: 'pycore' });
  indexRepo(store, pyApp, { repoName: 'pyapp' });
  return store;
}

test('python extractor names external imports and use sites by package (§8.1)', { skip: !hasPython }, () => {
  const store = indexedPyPair();
  const open = store.unresolvedEdges('pyapp').map((e) => `${e.fromFile} ${e.kind} ${e.toName}`);

  // the import itself, and its `#`-qualified binding
  assert.ok(open.includes('app/service.py imports taskcore'), JSON.stringify(open));
  assert.ok(open.includes('app/service.py imports taskcore#create_task'), JSON.stringify(open));
  // the aliased import carries the local name; its call site is named by the EXPORT
  assert.ok(open.includes('app/report.py imports taskcore#overdue as is_overdue'), JSON.stringify(open));
  assert.ok(open.includes('app/report.py calls taskcore#overdue'), JSON.stringify(open));
  // an undeclared package is named the same way — naming is not resolving
  assert.ok(open.includes('app/service.py calls uuid#uuid4'), JSON.stringify(open));
  // a method call carries only its bare name: nothing bound it, nothing can link it
  assert.ok(open.includes('app/service.py calls _store.add'), JSON.stringify(open));
  store.close();
});

test('python link resolves cross-repo calls through the declared package', { skip: !hasPython }, () => {
  const store = indexedPyPair();
  const report = link(store, PY_MAP);
  assert.equal(report.ambiguous.length, 0, JSON.stringify(report.ambiguous));
  assert.equal(report.missingTargets.length, 0, JSON.stringify(report.missingTargets));

  const calls = store
    .crossRepoEdges()
    .filter((e) => e.kind === 'calls')
    .map((e) => `${e.from.repo}:${e.from.container ? `${e.from.container}.` : ''}${e.from.name} → ${e.to.repo}:${e.to.name}`);
  assert.ok(calls.includes('pyapp:add_task → pycore:create_task'), JSON.stringify(calls));
  assert.ok(calls.includes('pyapp:overdue_count → pycore:overdue'), JSON.stringify(calls));
  // the aliased call site (`is_overdue`) binds back to the exported name
  assert.ok(calls.includes('pyapp:overdue_titles → pycore:overdue'), JSON.stringify(calls));

  // an undeclared package stays exactly as extracted; a method call is never name-matched
  const still = store.unresolvedEdges('pyapp').map((e) => e.toName);
  assert.ok(still.includes('uuid#uuid4'), 'undeclared package is left alone');
  assert.ok(still.includes('_store.add'), 'a method call is not linked by name');
  store.close();
});

test('the python golden set measures the difference: unlinked 6/13, linked 13/13', { skip: !hasPython }, () => {
  const store = indexedPyPair();
  const cases = loadGoldenFile(join(repoRoot, 'eval', 'golden', 'cross-repo-py.json'));

  const before = runEval(store, pyRoots, cases, { hops: 2, budget: 8000 });
  assert.equal(before.aggregate.totalMatched, 6, JSON.stringify(before.aggregate));

  link(store, PY_MAP);
  const after = runEval(store, pyRoots, cases, { hops: 2, budget: 8000 });
  assert.equal(after.aggregate.totalMatched, 13, JSON.stringify(after.aggregate));
  assert.equal(after.aggregate.microRecall, 1);
  store.close();
});

// ---- Go: an inline module pair (a `replace` directive, no module cache) ----

let goBinary: string | null = null;
function goExtractor(): string {
  if (goBinary) return goBinary;
  const out = join(mkdtempSync(join(tmpdir(), 'librarian-go-bin-')), 'librarian-go-extractor');
  const res = spawnSync('go', ['build', '-o', out, '.'], {
    cwd: join(repoRoot, 'go-extractor'),
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, `go build failed: ${res.stderr}`);
  goBinary = out;
  return out;
}

test('go link resolves a cross-repo call, and a method call stays raw (§8.1)', { skip: !hasGo }, () => {
  process.env.LIBRARIAN_GO_EXTRACTOR = goExtractor();
  const base = mkdtempSync(join(tmpdir(), 'librarian-go-cross-'));
  const core = join(base, 'go-core');
  const app = join(base, 'go-app');
  mkdirSync(core, { recursive: true });
  mkdirSync(app, { recursive: true });
  writeFileSync(join(core, 'go.mod'), 'module example.com/taskcore\n\ngo 1.21\n');
  writeFileSync(
    join(core, 'task.go'),
    `package taskcore

type Task struct{ ID string }

func CreateTask(id string) Task { return Task{ID: id} }

func (t Task) Touch() Task { return t }
`
  );
  writeFileSync(
    join(app, 'go.mod'),
    'module example.com/taskapp\n\ngo 1.21\n\nrequire example.com/taskcore v0.0.0\n\nreplace example.com/taskcore => ../go-core\n'
  );
  writeFileSync(
    join(app, 'service.go'),
    `package app

import "example.com/taskcore"

func AddTask(id string) taskcore.Task {
	t := taskcore.CreateTask(id)
	return t.Touch()
}
`
  );

  const store = new Store(':memory:');
  indexRepo(store, core, { repoName: 'gocore' });
  indexRepo(store, app, { repoName: 'goapp' });

  // the free function is named by its import path; the method call is not
  const open = store.unresolvedEdges('goapp').map((e) => e.toName);
  assert.ok(open.includes('example.com/taskcore#CreateTask'), JSON.stringify(open));
  assert.ok(open.includes('t.Touch'), 'a method call keeps its raw selector — no origin to bind');

  link(store, { packages: [{ package: 'example.com/taskcore', repo: 'gocore' }] });
  const calls = store.crossRepoEdges().filter((e) => e.kind === 'calls').map((e) => `${e.from.name} → ${e.to.name}`);
  assert.deepEqual(calls, ['AddTask → CreateTask'], 'only the package-level call links; Touch() stays local');
  store.close();
});

// ---- PHP: an inline namespace pair ----

test('php link resolves cross-repo new/function calls, method call stays raw (§8.1)', { skip: !hasPhp }, () => {
  const base = mkdtempSync(join(tmpdir(), 'librarian-php-cross-'));
  const core = join(base, 'php-core');
  const app = join(base, 'php-app');
  mkdirSync(join(core, 'src'), { recursive: true });
  mkdirSync(join(app, 'src'), { recursive: true });
  writeFileSync(
    join(core, 'src', 'Task.php'),
    `<?php
namespace Acme\\Core;

class Task {
    public function __construct(public string $id, public string $title) {}
    public function touch(): void {}
}

function makeTask(string $id, string $title): Task {
    return new Task($id, $title);
}
`
  );
  writeFileSync(
    join(app, 'src', 'Service.php'),
    `<?php
namespace Acme\\App;

use Acme\\Core\\Task;
use function Acme\\Core\\makeTask;

class Service {
    public function add(string $title): Task {
        $t = new Task("id-1", $title);
        $t->touch();
        return makeTask($t->id, $title);
    }
}
`
  );

  const store = new Store(':memory:');
  indexRepo(store, core, { repoName: 'phpcore' });
  indexRepo(store, app, { repoName: 'phpapp' });

  const open = store.unresolvedEdges('phpapp').map((e) => e.toName);
  assert.ok(open.includes('Acme\\Core#Task'), JSON.stringify(open)); // new Task()
  assert.ok(open.includes('Acme\\Core#makeTask'), JSON.stringify(open)); // makeTask()
  assert.ok(open.includes('->touch'), 'the dynamic method call keeps its raw name');

  link(store, { packages: [{ package: 'Acme\\Core', repo: 'phpcore' }] });
  const calls = store.crossRepoEdges().filter((e) => e.kind === 'calls').map((e) => `${e.from.name} → ${e.to.name}`);
  assert.ok(calls.includes('add → Task'), JSON.stringify(calls));
  assert.ok(calls.includes('add → makeTask'), JSON.stringify(calls));
  store.close();
});
