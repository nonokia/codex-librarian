import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.js';
import { indexRepo } from '../indexer.js';
import { parseUnifiedDiff } from '../diff.js';
import { retrieveForDiff } from '../retrieval.js';
import { assembleReviewPack, renderReviewPack } from '../contextpack.js';
import { buildReviewRequest, renderReviewMarkdown, type ReviewResult } from '../review.js';

function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'librarian-pack-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'core.ts'),
    `export function load(): number { return 1; }
export function fetchData(): number { return load() * 2; }
`
  );
  writeFileSync(
    join(root, 'src', 'app.ts'),
    `import { load, fetchData } from './core.ts';
export function run(): void { fetchData(); }
export const alias = load;
`
  );
  writeFileSync(
    join(root, 'src', 'core.test.ts'),
    `import { fetchData } from './core.ts';
declare function it(t: string, f: () => void): void;
it('doubles the loaded value', () => { fetchData(); });
`
  );
  return root;
}

const DIFF = `--- a/src/core.ts
+++ b/src/core.ts
@@ -2,1 +2,1 @@
-export function fetchData(): number { return load() * 2; }
+export function fetchData(): number { return load() * 3; }
`;

test('assembleReviewPack sections items by direction and test-ness', () => {
  const root = fixtureRepo();
  const store = new Store(':memory:');
  indexRepo(store, root);

  const retrieved = retrieveForDiff(store, root, parseUnifiedDiff(DIFF), {
    hops: 2,
    budget: 8000,
    withSource: true,
  });
  const pack = assembleReviewPack(DIFF, retrieved);

  assert.deepEqual(pack.changed.map((i) => i.name), ['fetchData']);
  assert.ok(pack.callers.some((i) => i.name === 'run'), `run is a caller: ${JSON.stringify(pack.callers.map(i=>i.name))}`);
  assert.ok(pack.callees.some((i) => i.name === 'load'), 'load is a callee');
  assert.ok(
    pack.tests.some((i) => i.file === 'src/core.test.ts'),
    'test block lands in the tests section'
  );
  assert.ok(pack.changed[0].text?.includes('fetchData'), 'seed carries source text');

  const md = renderReviewPack(pack);
  for (const heading of ['変更 diff', '変更されたコード', '呼び出し元', '呼び出し先', '関連テスト', 'Notes']) {
    assert.ok(md.includes(heading), `rendered pack has section: ${heading}`);
  }
  assert.ok(md.includes('load() * 3'), 'diff text is embedded');

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('buildReviewRequest embeds the pack and demands structured output', () => {
  const root = fixtureRepo();
  const store = new Store(':memory:');
  indexRepo(store, root);
  const retrieved = retrieveForDiff(store, root, parseUnifiedDiff(DIFF), { withSource: true });
  const pack = assembleReviewPack(DIFF, retrieved);
  const req = buildReviewRequest(pack, 'claude-opus-4-8');

  assert.equal(req.model, 'claude-opus-4-8');
  assert.equal(req.thinking.type, 'adaptive');
  assert.equal(req.output_config.format.type, 'json_schema');
  assert.ok(req.messages[0].content.includes('Context Pack'));
  assert.ok(req.system.includes('diff 単体では正しいが'));

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('renderReviewMarkdown counts graph-grounded findings', () => {
  const result: ReviewResult = {
    summary: '概ね問題なし。',
    verdict: 'comment',
    findings: [
      {
        severity: 'major',
        file: 'src/core.ts',
        line: 2,
        title: '倍率変更が呼び出し元の期待を破る',
        body: 'run() は 2 倍を前提にしている。',
        evidence: ['callers', 'tests'],
      },
      {
        severity: 'info',
        file: 'src/core.ts',
        line: null,
        title: 'diff 内の軽微な指摘',
        body: '...',
        evidence: ['diff'],
      },
    ],
  };
  const md = renderReviewMarkdown(result);
  assert.ok(md.includes('findings: 2 (うち diff 外の文脈を根拠にしたもの: 1)'));
  assert.ok(md.includes('🟧'));
  assert.ok(md.includes('src/core.ts:2'));
});
