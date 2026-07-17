import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../store/store.js';
import { indexRepo } from '../app/index.js';
import { runEval, loadGoldenFile } from '../app/eval.js';
import { PROTOCOL_NAME, PROTOCOL_VERSION, parseCapabilities } from '../protocol/scip.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = join(repoRoot, 'ansible-extractor', 'extract.py');
const fixture = join(repoRoot, 'eval', 'fixtures', 'ansible-taskflow');
const golden = join(repoRoot, 'eval', 'golden', 'ansible-taskflow.json');

const hasPython = spawnSync('python3', ['-c', 'import yaml'], { encoding: 'utf8' }).status === 0;
const hasGo = spawnSync('go', ['version'], { encoding: 'utf8' }).status === 0;

/** The fixture opts in via its committed .librarian/extractors.json (the
 *  shared #37/#39 routing decision) — indexRepo picks it up from the root. */
function indexedFixture(): Store {
  const store = new Store(':memory:');
  indexRepo(store, fixture);
  return store;
}

test('opt-in registry routes .yml to the ansible extractor (not the k8s built-in)', { skip: !hasPython }, () => {
  const store = indexedFixture();
  const names = new Map(store.findSymbols('', 200).map((s) => [s.name, s.kind]));
  assert.equal(names.get('play.Deploy taskflow api'), 'resource', 'plays are resources');
  assert.equal(names.get('task.Deploy app config'), 'function', 'named tasks');
  assert.equal(names.get('handler.Restart api'), 'function', 'handlers');
  assert.equal(names.get('var.api_port'), 'variable', 'defaults keys');
  assert.equal(names.get('role.taskflow_api'), 'module', 'role anchor at tasks/main.yml');
  store.close();
});

test('cross-file references resolve: notify → handler, play → role, jinja → var', { skip: !hasPython }, () => {
  const store = indexedFixture();
  const deploy = store.findSymbols('task.Deploy app config')[0];
  const handler = store.findSymbols('handler.Restart api')[0];
  const play = store.findSymbols('play.Deploy taskflow api')[0];
  const role = store.findSymbols('role.taskflow_api')[0];
  const dbHost = store.findSymbols('var.db_host')[0];

  const out = store.edgesOf(deploy.id).out;
  assert.ok(out.some((e) => e.toId === handler.id && e.resolved), 'notify resolves cross-file');
  assert.ok(out.some((e) => e.toId === dbHost.id && e.resolved), '{{ db_host }} resolves to group_vars');
  assert.ok(
    store.edgesOf(play.id).out.some((e) => e.toId === role.id && e.resolved),
    'roles: resolves to the role anchor'
  );
  store.close();
});

test('dynamic and external references stay honestly unresolved', { skip: !hasPython }, () => {
  const store = indexedFixture();
  const play = store.findSymbols('play.Provision database')[0];
  assert.ok(
    store.edgesOf(play.id).out.some((e) => !e.resolved && e.toName === 'geerlingguy.postgresql'),
    'Galaxy role keeps its raw name as the specifier'
  );
  const createRole = store.findSymbols('task.Create app role')[0];
  assert.ok(
    store.edgesOf(createRole.id).out.some((e) => !e.resolved && e.toName === 'var.db_password'),
    'a repo-undefined variable stays resolved=0'
  );
  const deploy = store.findSymbols('task.Deploy app config')[0];
  assert.ok(
    store.edgesOf(deploy.id).out.some(
      (e) => !e.resolved && e.toName === 'roles/taskflow_api/templates/api.env.j2'
    ),
    'template src is an unresolved repo path (.j2 unclaimed)'
  );
  store.close();
});

test('include_tasks is an imports edge to the target file module', { skip: !hasPython }, () => {
  const store = indexedFixture();
  const role = store.findSymbols('role.taskflow_api')[0];
  const imports = store.edgesOf(role.id).out.filter((e) => e.kind === 'imports' && e.resolved);
  const target = store.findSymbols('', 200).find((s) => s.id === imports[0]?.toId);
  assert.equal(target?.file, 'roles/taskflow_api/tasks/setup-user.yml');
  store.close();
});

test('eval baseline: the reference graph recovers the golden blast radius', { skip: !hasPython }, () => {
  const store = indexedFixture();
  const report = runEval(store, () => fixture, loadGoldenFile(golden), { hops: 2, budget: 8000 });
  assert.equal(report.aggregate.microRecall, 1, 'perfect micro recall on the ansible golden');
  assert.equal(report.aggregate.perfectCases, report.aggregate.cases);
  store.close();
});

test('without the opt-in, the same YAML falls to the k8s built-in as modules only', { skip: !hasGo }, () => {
  const root = mkdtempSync(join(tmpdir(), 'librarian-ansible-noopt-'));
  try {
    writeFileSync(join(root, 'site.yml'), '---\n- name: Play\n  hosts: web\n  roles: [x]\n');
    const store = new Store(':memory:');
    indexRepo(store, root);
    assert.deepEqual(
      store.findSymbols('', 50).map((s) => s.kind),
      ['module'],
      'no extractors.json → k8s built-in claims .yml, self-declaration gate yields module only'
    );
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--capabilities answers the handshake and announces the parser', { skip: !hasPython }, () => {
  const res = spawnSync('python3', [script, '--capabilities'], { encoding: 'utf8', input: 'IGNORED' });
  assert.equal(res.status, 0);
  const caps = parseCapabilities(JSON.parse(res.stdout));
  assert.equal(caps.protocol, PROTOCOL_NAME);
  assert.equal(caps.protocolVersion, PROTOCOL_VERSION);
  assert.equal(caps.name, 'librarian-ansible');
  assert.deepEqual(caps.extensions, ['.yml', '.yaml']);
  assert.equal((JSON.parse(res.stdout) as { parser?: string }).parser, 'pyyaml');
});
