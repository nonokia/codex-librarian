import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store/store.js';
import { indexRepo } from '../app/index.js';
import { parseUnifiedDiff } from '../core/diff.js';
import { retrieveForDiff, DEFAULT_STRATEGY } from '../core/retrieval.js';
import { learn, recordReviewOutcome } from '../app/loop.js';
import { runEval, type GoldenCase } from '../app/eval.js';
import type { ReviewResult } from '../app/review.js';

/**
 * Fixture with a deep call chain: entry -> mid -> deep -> deepest.
 * Changing `entry` and expecting `deepest` needs 3 hops — the default
 * 2-hop strategy cannot reach it, so `learn` must promote a hops-3
 * candidate for this signature.
 */
function chainRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'librarian-loop-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'chain.ts'),
    `export function deepest(): number { return 42; }
export function deep(): number { return deepest(); }
export function mid(): number { return deep(); }
export function entryA(): number { return mid(); }
export function entryB(): number { return mid() + 1; }
`
  );
  return root;
}

const CHAIN_CASES: GoldenCase[] = [
  {
    id: 'chain-a',
    title: 'changing entryA needs the full chain',
    target: { file: 'src/chain.ts', symbol: 'entryA' },
    expected: [
      { file: 'src/chain.ts', symbol: 'mid' },
      { file: 'src/chain.ts', symbol: 'deep' },
      { file: 'src/chain.ts', symbol: 'deepest' },
    ],
  },
  {
    id: 'chain-b',
    title: 'changing entryB needs the full chain',
    target: { file: 'src/chain.ts', symbol: 'entryB' },
    expected: [
      { file: 'src/chain.ts', symbol: 'mid' },
      { file: 'src/chain.ts', symbol: 'deep' },
      { file: 'src/chain.ts', symbol: 'deepest' },
    ],
  },
];

test('diff signature is deterministic and coarse', () => {
  const root = chainRepo();
  const store = new Store(':memory:');
  indexRepo(store, root);

  const diff = `--- a/src/chain.ts\n+++ b/src/chain.ts\n@@ -4,1 +4,1 @@\n-x\n+y\n`;
  const p1 = retrieveForDiff(store, root, parseUnifiedDiff(diff), {});
  const p2 = retrieveForDiff(store, root, parseUnifiedDiff(diff), {});
  assert.equal(p1.signature, p2.signature);
  assert.match(p1.signature, /^k=function\|d=src\|t=0\|n=1\|u=0$/);

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('learn promotes a deeper strategy and the cache is applied on retrieval', () => {
  const root = chainRepo();
  const store = new Store(':memory:');
  indexRepo(store, root);

  const before = runEval(store, root, CHAIN_CASES, { strategy: DEFAULT_STRATEGY });
  assert.ok(before.aggregate.microRecall < 1, 'default 2-hop misses the chain end');

  const report = learn(store, root, CHAIN_CASES, {});
  assert.equal(report.patternsLearned, 1, 'one signature learned');
  assert.match(report.signatures[0].chosen, /hops-3|wide/);
  assert.ok(report.train.learned > report.train.default);

  // cache is consulted on the normal retrieval path
  const after = runEval(store, root, CHAIN_CASES, { useCache: true });
  assert.equal(after.aggregate.microRecall, 1, 'cached strategy reaches the chain end');
  assert.ok(after.cases.every((c) => c.strategyFromCache), 'strategy came from PatternCache');

  // eval without cache still measures the untouched default (ADR-4 baseline)
  const control = runEval(store, root, CHAIN_CASES, {});
  assert.equal(control.aggregate.microRecall, before.aggregate.microRecall);

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('holdout split keeps selection and claim separate', () => {
  const root = chainRepo();
  const store = new Store(':memory:');
  indexRepo(store, root);

  const report = learn(store, root, CHAIN_CASES, { holdout: true });
  assert.ok(report.holdout, 'holdout numbers reported');
  assert.equal(report.holdout!.cases, 1, 'one of two same-signature cases held out');
  assert.ok(report.holdout!.learned >= report.holdout!.default);

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('retrieval log captures outcomes: review evidence and human feedback', () => {
  const store = new Store(':memory:');
  const id = store.logRetrieval({
    source: 'review',
    signature: 'k=function|d=src|t=0|n=1|u=0',
    strategy: JSON.stringify(DEFAULT_STRATEGY),
    fromCache: false,
    seeds: ['fetchData'],
    itemCount: 5,
    elidedCount: 1,
    usedChars: 4000,
    latencyMs: 12,
  });

  const result: ReviewResult = {
    summary: 'ok',
    verdict: 'comment',
    findings: [
      { severity: 'major', file: 'a.ts', line: 1, title: 't', body: 'b', evidence: ['callers', 'tests'] },
      { severity: 'info', file: 'a.ts', line: null, title: 't2', body: 'b2', evidence: ['diff'] },
    ],
  };
  recordReviewOutcome(store, id, result);
  assert.ok(store.updateRetrievalOutcome(id, { feedback: 1 }));
  assert.ok(!store.updateRetrievalOutcome(999, { feedback: 1 }), 'unknown id reports false');

  const row = store.listRetrievals(1)[0];
  assert.equal(row.grounded_findings, 1);
  assert.equal(row.total_findings, 2);
  assert.deepEqual(JSON.parse(row.sections_used as string), ['callers', 'diff', 'tests']);
  assert.equal(row.feedback, 1);

  store.close();
});

test('eval history accumulates a time series', () => {
  const store = new Store(':memory:');
  store.recordEval({ golden: 'g.json', cases: 16, microRecall: 0.696, macroRecall: 0.76, perfect: 8, budget: 8000, hops: 2, usedCache: false, note: 'baseline' });
  store.recordEval({ golden: 'g.json', cases: 16, microRecall: 0.87, macroRecall: 0.875, perfect: 10, budget: 8000, hops: 2, usedCache: true });
  const rows = store.evalHistory();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].note, 'baseline');
  assert.equal(rows[1].used_cache, 1);
  store.close();
});
