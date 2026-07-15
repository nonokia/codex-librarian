/**
 * Self-improving retrieval loop (§4-⑤, ADR-3).
 *
 * Structure: the deterministic pipeline is the base; when a diff signature
 * has no cached strategy we "explore" — today that exploration is a
 * deterministic sweep over a fixed candidate set scored by the Phase-0
 * harness (an LLM-agent explorer is a later, additive step) — and a winner
 * is promoted into PatternCache. Live signals (which pack sections review
 * findings cite, human 👍/👎) accumulate in retrieval_log for the same
 * promotion machinery once there is operational volume.
 *
 * Honesty rule (ADR-4): learning and evaluating on the same 16 cases would
 * be train=test. `learn --holdout` splits each signature group and reports
 * both numbers; the holdout figure is the one that may be claimed.
 */
import type { Store } from '../store/store.js';
import { DEFAULT_STRATEGY, type RootResolver, type Strategy } from '../core/retrieval.js';
import { runEval, type GoldenCase } from './eval.js';
import type { ReviewResult } from './review.js';

export interface NamedStrategy {
  name: string;
  strategy: Strategy;
}

const W = DEFAULT_STRATEGY.weights;

/** Fixed, deterministic exploration space — small on purpose (16 cases can't rank a big one). */
export const CANDIDATE_STRATEGIES: NamedStrategy[] = [
  { name: 'slow-decay', strategy: { ...DEFAULT_STRATEGY, decay: 0.8 } },
  { name: 'references-up', strategy: { ...DEFAULT_STRATEGY, weights: { ...W, references: 0.9 } } },
  { name: 'imports-up', strategy: { ...DEFAULT_STRATEGY, weights: { ...W, imports: 0.7 } } },
  { name: 'hops-3', strategy: { ...DEFAULT_STRATEGY, hops: 3, decay: 0.6 } },
  { name: 'wide', strategy: { ...DEFAULT_STRATEGY, hops: 3, decay: 0.75, weights: { ...W, references: 0.85 } } },
  { name: 'damp-low', strategy: { ...DEFAULT_STRATEGY, fileDamp: 0.35 } },
  { name: 'damp-high', strategy: { ...DEFAULT_STRATEGY, fileDamp: 0.7 } },
  { name: 'calls-focus', strategy: { ...DEFAULT_STRATEGY, decay: 0.7, weights: { calls: 1.0, dispatches: 0.85, extends: 0.7, references: 0.5, imports: 0.3 } } },
];

export interface LearnReport {
  signatures: {
    signature: string;
    cases: number;
    trainCases: number;
    baselineRecall: number;
    bestRecall: number;
    chosen: string; // candidate name or "default (kept)"
  }[];
  patternsLearned: number;
  train: { default: number; learned: number };
  holdout: { cases: number; default: number; learned: number } | null;
}

function microRecall(store: Store, root: RootResolver, cases: GoldenCase[], opts: {
  budget?: number;
  strategy?: Strategy;
  useCache?: boolean;
}): number {
  if (cases.length === 0) return 0;
  return runEval(store, root, cases, opts).aggregate.microRecall;
}

/**
 * Per-signature strategy sweep on the golden set; winners land in
 * pattern_cache. With `holdout`, every second case of each signature group
 * is held back and never used for selection.
 */
export function learn(
  store: Store,
  root: RootResolver,
  cases: GoldenCase[],
  opts: { budget?: number; holdout?: boolean } = {}
): LearnReport {
  const groups = new Map<string, GoldenCase[]>();
  for (const c of cases) {
    const sig = caseSignature(store, root, c, opts);
    const list = groups.get(sig) ?? [];
    list.push(c);
    groups.set(sig, list);
  }

  const trainAll: GoldenCase[] = [];
  const holdoutAll: GoldenCase[] = [];
  const report: LearnReport = {
    signatures: [],
    patternsLearned: 0,
    train: { default: 0, learned: 0 },
    holdout: null,
  };

  for (const [signature, group] of groups) {
    const train = opts.holdout ? group.filter((_, i) => i % 2 === 0) : group;
    const held = opts.holdout ? group.filter((_, i) => i % 2 === 1) : [];
    trainAll.push(...train);
    holdoutAll.push(...held);

    const baseline = microRecall(store, root, train, { budget: opts.budget, strategy: DEFAULT_STRATEGY });
    let bestName = 'default (kept)';
    let bestStrategy: Strategy | null = null;
    let bestScore = baseline;
    for (const cand of CANDIDATE_STRATEGIES) {
      const score = microRecall(store, root, train, { budget: opts.budget, strategy: cand.strategy });
      if (score > bestScore) {
        bestScore = score;
        bestName = cand.name;
        bestStrategy = cand.strategy;
      }
    }
    if (bestStrategy) {
      store.putPattern(signature, JSON.stringify(bestStrategy), 'learned', bestScore, baseline);
      report.patternsLearned++;
    }
    report.signatures.push({
      signature,
      cases: group.length,
      trainCases: train.length,
      baselineRecall: round(baseline),
      bestRecall: round(bestScore),
      chosen: bestName,
    });
  }

  report.train.default = round(microRecall(store, root, trainAll, { budget: opts.budget, strategy: DEFAULT_STRATEGY }));
  report.train.learned = round(microRecall(store, root, trainAll, { budget: opts.budget, useCache: true }));
  if (opts.holdout) {
    report.holdout = {
      cases: holdoutAll.length,
      default: round(microRecall(store, root, holdoutAll, { budget: opts.budget, strategy: DEFAULT_STRATEGY })),
      learned: round(microRecall(store, root, holdoutAll, { budget: opts.budget, useCache: true })),
    };
  }
  return report;
}

/** signature of a golden case = signature of the pack its diff produces */
function caseSignature(
  store: Store,
  root: RootResolver,
  c: GoldenCase,
  opts: { budget?: number }
): string {
  const single = runEval(store, root, [c], { budget: opts.budget, strategy: DEFAULT_STRATEGY });
  return single.cases[0].signature ?? 'unknown';
}

/**
 * Feedback signal (a) from §4-⑤: which pack sections the review's findings
 * actually cited. Written back onto the retrieval_log row of the review.
 */
export function recordReviewOutcome(store: Store, logId: number, result: ReviewResult): void {
  const sections = [...new Set(result.findings.flatMap((f) => f.evidence))].sort();
  const grounded = result.findings.filter((f) => f.evidence.some((e) => e !== 'diff')).length;
  store.updateRetrievalOutcome(logId, {
    sectionsUsed: sections,
    groundedFindings: grounded,
    totalFindings: result.findings.length,
  });
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}
