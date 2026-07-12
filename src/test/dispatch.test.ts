import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Store } from '../store.js';
import { indexRepo, TypeScriptExtractor } from '../indexer.js';
import type { ExtractionResult, Extractor } from '../extractor.js';
import { parseUnifiedDiff } from '../diff.js';
import { retrieveForDiff } from '../retrieval.js';

/**
 * Stub for a second language (#10): claims `.foo` files. Each line of the
 * form `fn NAME [-> CALLEE]` becomes a function symbol (with an optional
 * call edge), so dispatch, merging, and incremental re-index can all be
 * exercised without a real second grammar.
 */
class FooExtractor implements Extractor {
  readonly extensions = ['.foo'];
  invocations = 0;

  extract(rootDir: string, files: string[]): ExtractionResult[] {
    this.invocations++;
    const id = (file: string, name: string) =>
      createHash('sha256').update(`${file}::${name}::function`).digest('hex').slice(0, 20);
    const results: ExtractionResult[] = [];
    const declared = new Map<string, string>(); // name -> id (cross-file, this language)
    const parsed = files.map((abs) => {
      const file = relative(rootDir, abs).split(sep).join('/');
      const lines = readFileSync(abs, 'utf8').split('\n');
      return { file, lines };
    });
    for (const { file, lines } of parsed) {
      lines.forEach((l, i) => {
        const m = /^fn (\w+)/.exec(l);
        if (m) declared.set(m[1], id(file, m[1]));
      });
    }
    for (const { file, lines } of parsed) {
      const r: ExtractionResult = { file, symbols: [], edges: [] };
      lines.forEach((l, i) => {
        const m = /^fn (\w+)(?: -> (\w+))?/.exec(l);
        if (!m) return;
        r.symbols.push({
          id: id(file, m[1]),
          kind: 'function',
          name: m[1],
          file,
          container: null,
          spanStart: i + 1,
          spanEnd: i + 1,
          signature: null,
          doc: null,
        });
        if (m[2]) {
          const target = declared.get(m[2]) ?? null;
          r.edges.push({
            fromId: id(file, m[1]),
            toId: target,
            toName: m[2],
            kind: 'calls',
            resolved: target !== null,
          });
        }
      });
      results.push(r);
    }
    return results;
  }
}

function polyglotRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'librarian-dispatch-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.ts'), `export function tsMain(): number { return 1; }\n`);
  writeFileSync(join(root, 'src', 'svc.foo'), `fn fooMain -> fooHelper\nfn fooHelper\n`);
  writeFileSync(join(root, 'src', 'notes.bar'), `no extractor claims this\n`);
  return root;
}

test('files route to their extractor and results merge into one store', () => {
  const root = polyglotRepo();
  const store = new Store(':memory:');
  const foo = new FooExtractor();
  const report = indexRepo(store, root, { extractors: [new TypeScriptExtractor(), foo] });

  assert.equal(report.filesSeen, 2, 'unclaimed .bar is not discovered');
  assert.equal(foo.invocations, 1);

  const names = store.findSymbols('Main').map((s) => s.name).sort();
  assert.deepEqual(names, ['fooMain', 'tsMain'], 'both languages in the same db');

  const fooMain = store.findSymbols('fooMain')[0];
  const helper = store.findSymbols('fooHelper')[0];
  assert.ok(
    store.edgesOf(fooMain.id).out.some((e) => e.kind === 'calls' && e.toId === helper.id && e.resolved),
    'stub-language edges resolve within their own graph'
  );

  const stats = store.stats();
  assert.equal(stats.byExtension.ts, 1);
  assert.equal(stats.byExtension.foo, 1);

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('an extractor only runs when one of its files changed', () => {
  const root = polyglotRepo();
  const store = new Store(':memory:');
  const foo = new FooExtractor();
  const extractors = [new TypeScriptExtractor(), foo];
  indexRepo(store, root, { extractors });
  assert.equal(foo.invocations, 1);

  // touch only the TS file: foo extractor must not run again
  writeFileSync(join(root, 'src', 'app.ts'), `export function tsMain(): number { return 2; }\n`);
  const second = indexRepo(store, root, { extractors });
  assert.equal(second.filesIndexed, 1);
  assert.equal(foo.invocations, 1, 'foo extractor skipped — none of its files changed');

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('diff hunks in files no extractor claims fall into unknownFiles', () => {
  const root = polyglotRepo();
  const store = new Store(':memory:');
  indexRepo(store, root, { extractors: [new TypeScriptExtractor(), new FooExtractor()] });

  const diff = `--- a/src/notes.bar\n+++ b/src/notes.bar\n@@ -1,1 +1,1 @@\n-x\n+y\n--- a/src/svc.foo\n+++ b/src/svc.foo\n@@ -1,1 +1,1 @@\n-x\n+y\n`;
  const pack = retrieveForDiff(store, root, parseUnifiedDiff(diff), {});
  assert.deepEqual(pack.unknownFiles, ['src/notes.bar']);
  assert.ok(pack.seeds.some((s) => s.name === 'fooMain'), 'claimed language seeds normally');

  store.close();
  rmSync(root, { recursive: true, force: true });
});
