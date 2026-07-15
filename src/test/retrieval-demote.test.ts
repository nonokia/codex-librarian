/**
 * Opt-in packing demotion (#41): a candidate too large to pass in full is
 * packed as a reduced card instead of being elided, so every reachable symbol
 * reaches the consumer as full source or a signature — never nothing. The
 * option defaults off, so `librarian review`/eval pack exactly as before (that
 * invariant is covered by the golden tests; here we pin the demotion itself).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store/store.js';
import { indexRepo } from '../app/index.js';
import { expandContext, type Seed } from '../core/retrieval.js';
import type { SymbolRow } from '../store/store.js';

/** A repo whose `entry` calls one large helper and one tiny one. */
function fixture(): { root: string; store: Store } {
  const root = mkdtempSync(join(tmpdir(), 'librarian-demote-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  const bigBody = Array.from({ length: 40 }, (_, i) => `  const v${i} = ${i} * 2; // padding line ${i}`).join('\n');
  writeFileSync(
    join(root, 'src', 'lib.ts'),
    `/** Adds one. */
export function smallHelper(y: number): number {
  return y + 1;
}

/** A deliberately large function. */
export function bigHelper(x: number): number {
${bigBody}
  return x;
}

export function entry(n: number): number {
  return bigHelper(n) + smallHelper(n);
}
`
  );
  const store = new Store(':memory:');
  indexRepo(store, root, { repoName: 'demo' });
  return { root, store };
}

function seedOf(store: Store, name: string): Seed {
  const symbol = store.findSymbols(name).find((s) => s.kind === 'function')!;
  return { symbol, via: 'span-overlap' };
}

const CARD = (s: SymbolRow) => `SIG ${s.name}${s.signature ?? ''}`;

test('without demote, an oversized candidate is elided (unchanged packing)', () => {
  const { root, store } = fixture();
  const roots = () => root;
  const pack = expandContext(store, roots, [seedOf(store, 'entry')], { hops: 1, budget: 200, withSource: true });

  const names = pack.items.map((i) => i.name);
  assert.ok(names.includes('smallHelper'), 'the small neighbor fits');
  assert.ok(!names.includes('bigHelper'), 'the big neighbor does not fit');
  assert.ok(pack.elided.some((e) => e.name === 'bigHelper'), 'the big neighbor is elided');
  store.close();
});

test('with demote, the oversized candidate becomes a reduced signature card', () => {
  const { root, store } = fixture();
  const roots = () => root;
  const pack = expandContext(store, roots, [seedOf(store, 'entry')], {
    hops: 1,
    budget: 200,
    withSource: true,
    demote: { fraction: 0.4, reducedText: CARD },
  });

  const big = pack.items.find((i) => i.name === 'bigHelper');
  assert.ok(big, 'the big neighbor is packed rather than elided');
  assert.equal(big!.reduced, true, 'it is flagged reduced');
  assert.ok(big!.text!.startsWith('SIG bigHelper'), 'its text is the reduced card, not the full body');
  assert.ok(!big!.text!.includes('padding line'), 'the large body is not passed');
  assert.ok(pack.items.some((i) => i.name === 'smallHelper' && !i.reduced), 'the small neighbor stays full');
  assert.ok(!pack.elided.some((e) => e.name === 'bigHelper'), 'nothing reachable is elided anymore');
  store.close();
});

test('demote downgrades a candidate that fits but is oversized vs remaining budget', () => {
  const { root, store } = fixture();
  const roots = () => root;
  // Budget large enough that bigHelper's full source fits, but it alone exceeds
  // 40% of the remaining budget after the tiny neighbor — so it still demotes,
  // to keep one big item from eating the room the rest would use.
  const pack = expandContext(store, roots, [seedOf(store, 'entry')], {
    hops: 1,
    budget: 2000,
    withSource: true,
    demote: { fraction: 0.4, reducedText: CARD },
  });
  // baseline: with the same budget and NO demote, bigHelper is packed in full
  const full = expandContext(store, roots, [seedOf(store, 'entry')], { hops: 1, budget: 2000, withSource: true });
  assert.ok(
    full.items.find((i) => i.name === 'bigHelper')!.text!.includes('padding line'),
    'without demote the same budget packs the full body'
  );

  const big = pack.items.find((i) => i.name === 'bigHelper')!;
  assert.equal(big.reduced, true, 'the oversized-vs-remaining candidate demotes even though it would fit');
  store.close();
});
