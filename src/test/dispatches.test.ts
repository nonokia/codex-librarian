import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../store/store.js';
import { indexRepo } from '../app/index.js';
import { loadGoldenFile, runEval } from '../app/eval.js';
import {
  resolveDispatches,
  clearDispatches,
  parseDispatchName,
} from '../app/resolve-dispatches.js';

/**
 * Framework-convention dispatch (#43 / ADR-9): the php-extractor emits CakePHP
 * redirect/setAction as unresolved `dispatches` edges (Step 0), and
 * `resolve-dispatches` binds them by naming convention (Step 1). These tests
 * pin the detection, the convention-based resolution (with its refusals), the
 * reversibility/idempotency contract, and the eval A/B — the same discipline
 * `link.test.ts` gives cross-repo linking.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixture = join(repoRoot, 'eval', 'fixtures', 'cake-taskflow');
const golden = join(repoRoot, 'eval', 'golden', 'cake-taskflow.json');

const hasPhp = spawnSync('php', ['--version'], { encoding: 'utf8' }).status === 0;

function indexedFixture(): Store {
  const store = new Store(':memory:');
  indexRepo(store, fixture);
  return store;
}

/** an unresolved dispatches edge with this exact structured name leaves `from` */
function hasDispatch(store: Store, fromName: string, toName: string): boolean {
  const from = store.findSymbols(fromName)[0];
  if (!from) return false;
  return store
    .edgesOf(from.id)
    .out.some((e) => e.kind === 'dispatches' && !e.resolved && e.toName === toName);
}

test('parseDispatchName splits the structured binding name', () => {
  assert.deepEqual(parseDispatchName('dispatch Tasks#view'), { controller: 'Tasks', action: 'view' });
  assert.deepEqual(parseDispatchName('dispatch Admin/Users#edit'), {
    controller: 'Admin/Users',
    action: 'edit',
  });
  assert.equal(parseDispatchName('calls something'), null, 'non-dispatch name is left alone');
  assert.equal(parseDispatchName('dispatch Tasks'), null, 'missing #action is not a binding');
});

test('extractor emits redirect/setAction as unresolved dispatches edges', { skip: !hasPhp }, () => {
  const store = indexedFixture();

  // explicit controller + action
  assert.ok(hasDispatch(store, 'TasksController.complete', 'dispatch Tasks#index'), 'redirect(controller+action)');
  // controller omitted → same controller (enclosing *Controller convention name)
  assert.ok(hasDispatch(store, 'TasksController.add', 'dispatch Tasks#view'), 'redirect(action only) fills self controller');
  // cross-controller
  assert.ok(hasDispatch(store, 'TasksController.archive', 'dispatch Reports#summary'), 'cross-controller redirect');
  // setAction on the same controller
  assert.ok(hasDispatch(store, 'TasksController.edit', 'dispatch Tasks#view'), 'setAction dispatch');

  // dispatches edges are unresolved at extract time — resolution is Step 1
  assert.equal(store.countResolvedDispatches(), 0, 'nothing resolved before resolve-dispatches');
  store.close();
});

test('controller-only redirect defaults the action to index', { skip: !hasPhp }, () => {
  const root = mkdtempSync(join(tmpdir(), 'librarian-dispatch-default-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'HomeController.php'),
    `<?php
class HomeController {
  public function land() { return $this->redirect(['controller' => 'Foo']); }
}
`
  );
  const store = new Store(':memory:');
  indexRepo(store, root);
  assert.ok(hasDispatch(store, 'HomeController.land', 'dispatch Foo#index'), 'controller-only → default action index');
  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('only literal-string routing is recorded (dynamic dispatch is out of scope)', { skip: !hasPhp }, () => {
  const root = mkdtempSync(join(tmpdir(), 'librarian-dispatch-dynamic-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'DynController.php'),
    `<?php
class DynController {
  public function go(string $where) {
    $this->redirect($where);                          // variable target
    $this->redirect(['controller' => $where]);        // variable controller
    $this->setAction($where);                         // variable action
    return 1;
  }
}
`
  );
  const store = new Store(':memory:');
  indexRepo(store, root);
  const go = store.findSymbols('DynController.go')[0];
  assert.ok(go, 'the method indexed');
  assert.equal(
    store.edgesOf(go.id).out.filter((e) => e.kind === 'dispatches').length,
    0,
    'no dispatches edge for variable/expression routing'
  );
  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('resolve-dispatches binds by convention; missing target is reported, not guessed', { skip: !hasPhp }, () => {
  const store = indexedFixture();
  const report = resolveDispatches(store);

  assert.equal(report.newlyResolved, 4, 'four convention-resolvable dispatches');
  assert.equal(report.resolvedDispatches, 4);
  assert.deepEqual(report.ambiguous, [], 'no ambiguity in the fixture');
  assert.deepEqual(report.missingTargets, [], 'every target exists in the fixture');
  assert.equal(report.byController.TasksController, 3);
  assert.equal(report.byController.ReportsController, 1);

  // the edge now points at the real action method and traverses the graph
  const add = store.findSymbols('TasksController.add')[0];
  const view = store.findSymbols('TasksController.view')[0];
  assert.ok(
    store.edgesOf(add.id).out.some((e) => e.kind === 'dispatches' && e.resolved && e.toId === view.id),
    'add dispatches to the resolved view method'
  );
  const neighbors = store.neighborhood(add.id, 2).map((n) => n.name);
  assert.ok(neighbors.includes('view'), 'the dispatch target is reachable in the neighborhood');
  store.close();
});

test('missing convention target stays unresolved', { skip: !hasPhp }, () => {
  const root = mkdtempSync(join(tmpdir(), 'librarian-dispatch-missing-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  // redirect to an action the controller does not declare
  writeFileSync(
    join(root, 'src', 'ShopController.php'),
    `<?php
class ShopController {
  public function buy() { return $this->redirect(['action' => 'nope']); }
  public function view() { return 1; }
}
`
  );
  const store = new Store(':memory:');
  indexRepo(store, root);
  const report = resolveDispatches(store);
  assert.equal(report.newlyResolved, 0, 'no target named nope → nothing bound');
  assert.equal(report.resolvedDispatches, 0);
  assert.deepEqual(report.missingTargets, [{ controller: 'ShopController', action: 'nope' }]);
  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('ambiguous controller class is refused, not tiebroken', { skip: !hasPhp }, () => {
  const root = mkdtempSync(join(tmpdir(), 'librarian-dispatch-ambig-'));
  mkdirSync(join(root, 'a'), { recursive: true });
  mkdirSync(join(root, 'b'), { recursive: true });
  // two files each declaring an OrderController with a submit() action
  for (const dir of ['a', 'b']) {
    writeFileSync(
      join(root, dir, 'OrderController.php'),
      `<?php
namespace App\\${dir};
class OrderController {
  public function start() { return $this->redirect(['controller' => 'Order', 'action' => 'submit']); }
  public function submit() { return 1; }
}
`
    );
  }
  const store = new Store(':memory:');
  indexRepo(store, root);
  const report = resolveDispatches(store);
  assert.equal(report.newlyResolved, 0, 'ambiguous target is not bound');
  assert.equal(report.ambiguous.length, 1);
  assert.equal(report.ambiguous[0].controller, 'OrderController');
  assert.equal(report.ambiguous[0].action, 'submit');
  assert.equal(report.ambiguous[0].candidates.length, 2, 'both declarations reported');
  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('resolve-dispatches is idempotent, reversible, and dry-run writes nothing', { skip: !hasPhp }, () => {
  const store = indexedFixture();

  resolveDispatches(store);
  assert.equal(store.countResolvedDispatches(), 4);
  // idempotent: a second run binds nothing new
  assert.equal(resolveDispatches(store).newlyResolved, 0);

  // reversible: --clear restores the extractor's unresolved rows exactly
  const cleared = clearDispatches(store);
  assert.equal(cleared.cleared, 4);
  assert.equal(cleared.resolvedDispatches, 0);
  assert.ok(hasDispatch(store, 'TasksController.add', 'dispatch Tasks#view'), 'the raw dispatch name is back');

  // dry-run reports what would bind but leaves the store untouched
  const dry = resolveDispatches(store, { dryRun: true });
  assert.equal(dry.newlyResolved, 4);
  assert.equal(dry.dryRun, true);
  assert.equal(store.countResolvedDispatches(), 0, 'dry-run persisted nothing');
  store.close();
});

test('eval A/B: resolving dispatches lifts recall from partial to perfect', { skip: !hasPhp }, () => {
  const cases = loadGoldenFile(golden);
  const store = indexedFixture();

  const before = runEval(store, fixture, cases);
  assert.ok(before.aggregate.microRecall < 0.5, `before resolve recall is partial (${before.aggregate.microRecall})`);
  assert.equal(before.aggregate.perfectCases, 0, 'no case is complete without the dispatch edges');

  resolveDispatches(store);

  const after = runEval(store, fixture, cases);
  assert.equal(after.aggregate.microRecall, 1, 'every expected entry is retrieved once dispatches resolve');
  assert.equal(after.aggregate.perfectCases, cases.length, 'all cases perfect');
  store.close();
});
