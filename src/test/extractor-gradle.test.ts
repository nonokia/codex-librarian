import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../store/store.js';
import { indexRepo } from '../app/index.js';
import { GradleExtractor } from '../extractors/gradle.js';
import { isGradleSchemePath } from '../protocol/scip-export.js';
import { runEval, loadGoldenFile } from '../app/eval.js';
import { PROTOCOL_NAME, PROTOCOL_VERSION, parseCapabilities } from '../protocol/scip.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const extractorDir = join(repoRoot, 'gradle-extractor');
const fixture = join(repoRoot, 'eval', 'fixtures', 'gradle-taskflow');
const golden = join(repoRoot, 'eval', 'golden', 'gradle-taskflow.json');

const hasGo = spawnSync('go', ['version'], { encoding: 'utf8' }).status === 0;

let binary: string | null = null;
function builtBinary(): string {
  if (binary) return binary;
  const out = join(mkdtempSync(join(tmpdir(), 'librarian-gradle-bin-')), 'librarian-gradle-extractor');
  const res = spawnSync('go', ['build', '-o', out, '.'], { cwd: extractorDir, encoding: 'utf8' });
  assert.equal(res.status, 0, `go build failed: ${res.stderr}`);
  binary = out;
  return out;
}

function indexedFixture(): Store {
  process.env.LIBRARIAN_GRADLE_EXTRACTOR = builtBinary();
  const store = new Store(':memory:');
  indexRepo(store, fixture);
  return store;
}

test('claims routes build files and exactly the version catalog, not all .toml', () => {
  assert.ok(isGradleSchemePath('build.gradle'));
  assert.ok(isGradleSchemePath('app/build.gradle.kts'));
  assert.ok(isGradleSchemePath('settings.gradle.kts'));
  assert.ok(isGradleSchemePath('gradle/libs.versions.toml'));
  assert.ok(!isGradleSchemePath('Cargo.toml'));
  assert.ok(!isGradleSchemePath('pyproject.toml'));
  assert.ok(!isGradleSchemePath('other/libs.versions.toml'));
});

test('gradle fixture indexes projects, settings, tasks and catalog entries', { skip: !hasGo }, () => {
  const store = indexedFixture();
  const app = store.findSymbols('project.:app')[0];
  assert.ok(app, 'project addressed by its path');
  assert.equal(app.kind, 'resource', 'projects are seedable resources, not module-kind');
  assert.equal(store.findSymbols('settings')[0]?.kind, 'resource');
  assert.equal(store.findSymbols('task.deploy')[0]?.kind, 'function');
  assert.equal(store.findSymbols('libs.commons.text')[0]?.kind, 'variable', 'dash key → dot accessor');
  store.close();
});

test('the build graph resolves across both DSLs', { skip: !hasGo }, () => {
  const store = indexedFixture();
  const core = store.findSymbols('project.:core')[0];
  const app = store.findSymbols('project.:app')[0];
  const worker = store.findSymbols('project.:worker')[0];
  const settings = store.findSymbols('settings')[0];

  assert.ok(
    store.edgesOf(app.id).out.some((e) => e.toId === core.id && e.resolved),
    'Kotlin DSL implementation(project(":core"))'
  );
  assert.ok(
    store.edgesOf(worker.id).out.some((e) => e.toId === core.id && e.resolved),
    "Groovy DSL implementation project(':core')"
  );
  const included = store.edgesOf(settings.id).out.filter((e) => e.kind === 'imports' && e.resolved);
  assert.equal(included.length, 3, 'settings include → all three projects');
  store.close();
});

test('version catalog entries link usage to coordinates', { skip: !hasGo }, () => {
  const store = indexedFixture();
  const entry = store.findSymbols('libs.commons.text')[0];
  const app = store.findSymbols('project.:app')[0];
  assert.ok(
    store.edgesOf(app.id).out.some((e) => e.toId === entry.id && e.resolved),
    'implementation(libs.commons.text) resolves to the catalog entry'
  );
  assert.ok(
    store.edgesOf(entry.id).out.some(
      (e) => e.kind === 'imports' && !e.resolved && e.toName === 'org.apache.commons:commons-text'
    ),
    'the entry carries its version-dropped coordinate (#35 specifier)'
  );
  const shadow = store.findSymbols('libs.plugins.shadow')[0];
  assert.ok(
    store.edgesOf(app.id).out.some((e) => e.toId === shadow.id && e.resolved),
    'alias(libs.plugins.shadow) resolves to the catalog plugin'
  );
  store.close();
});

test('external coordinates and plugin ids stay unresolved specifiers', { skip: !hasGo }, () => {
  const store = indexedFixture();
  const core = store.findSymbols('project.:core')[0];
  const out = store.edgesOf(core.id).out;
  assert.ok(
    out.some((e) => e.kind === 'imports' && !e.resolved && e.toName === 'com.google.guava:guava'),
    'Maven coordinate drops the version'
  );
  assert.ok(
    out.some((e) => e.kind === 'imports' && !e.resolved && e.toName === 'org.jetbrains.kotlin.jvm'),
    'kotlin("jvm") normalizes to the plugin id'
  );
  const deploy = store.findSymbols('task.deploy')[0];
  assert.ok(
    store.edgesOf(deploy.id).out.some((e) => !e.resolved && e.toName === 'build'),
    'dependsOn on an undeclared task stays unresolved'
  );
  store.close();
});

test('eval baseline: the build graph recovers the golden blast radius', { skip: !hasGo }, () => {
  const store = indexedFixture();
  const report = runEval(store, () => fixture, loadGoldenFile(golden), { hops: 2, budget: 8000 });
  assert.equal(report.aggregate.microRecall, 1, 'perfect micro recall on the gradle golden');
  assert.equal(report.aggregate.perfectCases, report.aggregate.cases);
  store.close();
});

test('without a Go toolchain the claimed files degrade to file-level modules', () => {
  const root = mkdtempSync(join(tmpdir(), 'librarian-gradle-degrade-'));
  writeFileSync(join(root, 'build.gradle.kts'), 'plugins { kotlin("jvm") }\n');
  const saved = { bin: process.env.LIBRARIAN_GRADLE_EXTRACTOR, path: process.env.PATH };
  delete process.env.LIBRARIAN_GRADLE_EXTRACTOR;
  process.env.PATH = '/nonexistent';
  try {
    const results = new GradleExtractor().extract(root, [join(root, 'build.gradle.kts')]);
    assert.equal(results.length, 1);
    assert.deepEqual(results[0].symbols.map((s) => s.kind), ['module']);
  } finally {
    if (saved.bin !== undefined) process.env.LIBRARIAN_GRADLE_EXTRACTOR = saved.bin;
    process.env.PATH = saved.path;
    rmSync(root, { recursive: true, force: true });
  }
});

test('--capabilities answers the handshake and announces basename patterns', { skip: !hasGo }, () => {
  const res = spawnSync(builtBinary(), ['--capabilities'], { encoding: 'utf8', input: 'IGNORED' });
  assert.equal(res.status, 0);
  const caps = parseCapabilities(JSON.parse(res.stdout));
  assert.equal(caps.protocol, PROTOCOL_NAME);
  assert.equal(caps.protocolVersion, PROTOCOL_VERSION);
  assert.equal(caps.name, 'librarian-gradle');
  assert.deepEqual(caps.extensions, ['.gradle', '.gradle.kts']);
  const raw = JSON.parse(res.stdout) as { basenames?: string[] };
  assert.deepEqual(raw.basenames, ['gradle/libs.versions.toml']);
});
