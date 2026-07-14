import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SymbolInformation_Kind, SymbolRole } from '@scip-code/scip';
import { Store } from '../store/store.js';
import { indexRepo } from '../app/index.js';
import { parseRegistry, resolveExtractors, entryToExtractor } from '../app/registry.js';
import { createScipIndex, scipToJson } from '../protocol/scip.js';
import { runEval, loadGoldenFile } from '../app/eval.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// --- parseRegistry validation ------------------------------------------------

test('parseRegistry accepts a well-formed registry', () => {
  const entries = parseRegistry({
    version: 1,
    extractors: [{ name: 'librarian-rust', extensions: ['.rs'], command: 'librarian-rust-extractor' }],
  });
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].extensions, ['.rs']);
  assert.deepEqual(entries[0].args, [], 'args defaults to []');
});

test('parseRegistry rejects malformed registries with precise errors', () => {
  assert.throws(() => parseRegistry(null), /must be a JSON object/);
  assert.throws(() => parseRegistry({ version: 2, extractors: [] }), /version 2 unsupported/);
  assert.throws(() => parseRegistry({ version: 1 }), /requires an "extractors" array/);
  assert.throws(
    () => parseRegistry({ version: 1, extractors: [{ name: '', extensions: ['.rs'], command: 'x' }] }),
    /name must be a non-empty string/
  );
  assert.throws(
    () => parseRegistry({ version: 1, extractors: [{ name: 'x', extensions: ['rs'], command: 'x' }] }),
    /dot-prefixed extensions/
  );
  assert.throws(
    () => parseRegistry({ version: 1, extractors: [{ name: 'x', extensions: ['.rs'], command: '' }] }),
    /command must be a non-empty string/
  );
});

// --- resolveExtractors override precedence (design §4.3, axis A) --------------

test('resolveExtractors overlays the registry over built-ins, registry wins per extension', () => {
  const root = mkdtempSync(join(tmpdir(), 'librarian-registry-'));
  try {
    mkdirSync(join(root, '.librarian'), { recursive: true });
    writeFileSync(
      join(root, '.librarian', 'extractors.json'),
      JSON.stringify({
        version: 1,
        extractors: [
          { name: 'librarian-rust', extensions: ['.rs'], command: 'librarian-rust-extractor' },
          { name: 'my-go', extensions: ['.go'], command: 'my-go-extractor' },
        ],
      })
    );
    const extractors = resolveExtractors(root);
    const forExt = (ext: string) => extractors.find((x) => x.extensions.includes(ext));

    // new language shows up
    assert.equal((forExt('.rs') as { name?: string })?.name, 'librarian-rust');
    // registry overrides the built-in Go reference plugin for .go
    assert.equal((forExt('.go') as { name?: string })?.name, 'my-go');
    // .ts is untouched — still the in-process TypeScript anchor (not a subprocess)
    const ts = forExt('.ts');
    assert.ok(ts && !('name' in ts), '.ts stays the in-process TypeScriptExtractor');
    // .php built-in survives (not overridden)
    assert.equal((forExt('.php') as { name?: string })?.name, 'librarian-php');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveExtractors returns exactly the built-ins when no registry file exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'librarian-noreg-'));
  try {
    const exts = resolveExtractors(root).flatMap((x) => x.extensions);
    assert.ok(exts.includes('.ts') && exts.includes('.go') && exts.includes('.php'));
    assert.ok(!exts.includes('.rs'), 'no third-party extensions without a registry');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- end-to-end: a third-party plugin drives extraction via the registry -----

/**
 * A minimal "echo" plugin (any language, here Node): answers --capabilities and
 * otherwise prints a fixed SCIP+ envelope. Proves the registry path end to end —
 * discover file → route to the declared command → spawn → ingest — without
 * needing a real language toolchain (design §11, Step 3).
 */
function writeEchoPlugin(dir: string, envelope: unknown): string {
  const envPath = join(dir, 'envelope.json');
  writeFileSync(envPath, JSON.stringify(envelope));
  const script = join(dir, 'echo-plugin.cjs');
  writeFileSync(
    script,
    `const fs = require('fs');\n` +
      `if (process.argv.includes('--capabilities')) {\n` +
      `  process.stdout.write(JSON.stringify({ protocol: 'librarian-scip-plus', protocolVersion: 1, name: 'librarian-echo', extensions: ['.xyz'] }));\n` +
      `  process.exit(0);\n` +
      `}\n` +
      `process.stdout.write(fs.readFileSync(${JSON.stringify(envPath)}, 'utf8'));\n`
  );
  return script;
}

function echoEnvelope(): unknown {
  const symbol = 'librarian-echo . . . `thing.xyz`/greet().';
  return JSON.parse(
    JSON.stringify({
      scip: scipToJson(
        createScipIndex({
          metadata: { toolInfo: { name: 'librarian-echo', version: '0.1.0' }, projectRoot: 'file:///repo' },
          documents: [
            {
              relativePath: 'thing.xyz',
              language: 'xyz',
              occurrences: [
                {
                  typedRange: {
                    case: 'multiLineRange',
                    value: { startLine: 0, startCharacter: 0, endLine: 2, endCharacter: 0 },
                  },
                  symbol,
                  symbolRoles: SymbolRole.Definition,
                },
              ],
              symbols: [{ symbol, kind: SymbolInformation_Kind.Function, displayName: 'greet' }],
            },
          ],
        })
      ),
      ext: { version: 1, documents: [{ relativePath: 'thing.xyz', symbols: [], edges: [] }] },
    })
  );
}

test('a .librarian/extractors.json plugin indexes a novel extension end to end', () => {
  const root = mkdtempSync(join(tmpdir(), 'librarian-echo-repo-'));
  const tools = mkdtempSync(join(tmpdir(), 'librarian-echo-tools-'));
  try {
    writeFileSync(join(root, 'thing.xyz'), 'greet does a thing\n');
    const script = writeEchoPlugin(tools, echoEnvelope());
    mkdirSync(join(root, '.librarian'), { recursive: true });
    writeFileSync(
      join(root, '.librarian', 'extractors.json'),
      JSON.stringify({
        version: 1,
        extractors: [{ name: 'librarian-echo', extensions: ['.xyz'], command: 'node', args: [script] }],
      })
    );

    const store = new Store(':memory:');
    const report = indexRepo(store, root);
    assert.equal(report.filesIndexed, 1, 'the .xyz file was routed to the registry plugin');
    const greet = store.findSymbols('greet')[0];
    assert.ok(greet, 'the plugin-emitted symbol landed in the store');
    assert.equal(greet.kind, 'function');
    assert.equal(greet.file, 'thing.xyz');
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(tools, { recursive: true, force: true });
  }
});

// --- a registry-declared Go plugin reproduces the native numbers -------------

const hasGo = spawnSync('go', ['version'], { encoding: 'utf8' }).status === 0;

test('Go driven through a registry entry reproduces the native eval aggregate', { skip: !hasGo }, () => {
  const goExtractorDir = join(repoRoot, 'go-extractor');
  const out = join(mkdtempSync(join(tmpdir(), 'librarian-go-reg-')), 'librarian-go-extractor');
  const build = spawnSync('go', ['build', '-o', out, '.'], { cwd: goExtractorDir, encoding: 'utf8' });
  assert.equal(build.status, 0, `go build failed: ${build.stderr}`);

  // A registry entry pointing at the just-built binary — the same plugin, driven
  // through the registry path instead of the built-in GoExtractor subclass.
  const viaRegistry = entryToExtractor(
    { name: 'librarian-go', extensions: ['.go'], command: out, args: [] },
    repoRoot
  );
  const fixture = join(repoRoot, 'eval', 'fixtures', 'go-taskflow');
  const store = new Store(':memory:');
  indexRepo(store, fixture, { extractors: [viaRegistry] });
  const report = runEval(store, fixture, loadGoldenFile(join(repoRoot, 'eval', 'golden', 'go-taskflow.json')), {
    hops: 2,
    budget: 8000,
  });
  assert.equal(report.aggregate.totalMatched, 45);
  assert.equal(report.aggregate.totalExpected, 47);
  assert.equal(report.aggregate.microRecall, 0.957);
  store.close();
});
