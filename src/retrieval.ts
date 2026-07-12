/**
 * Deterministic retrieval — stage 1 of the Context Engine (§4-③, ADR-3).
 *
 * No LLM here by design: seeds come from diff geometry, expansion is a
 * weighted BFS over resolved graph edges, and packing is greedy under a
 * character budget. Reproducible and cheap; the semantic stage (embeddings)
 * is added later and only ever *supplements* this.
 *
 * The edge weights / decay / budget below are an unvalidated baseline: they
 * exist to be measured by the Phase-0 harness (eval.ts), not because they are
 * believed optimal.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FileRanges } from './diff.js';
import type { EdgeKind, Store, SymbolRow } from './store.js';

/**
 * A retrieval strategy: everything the deterministic expansion can vary.
 * The default carries the Phase-0-measured baseline values; PatternCache
 * (§4-⑤) stores per-diff-signature overrides that beat it on the harness.
 */
export interface Strategy {
  hops: number;
  decay: number;
  weights: Record<EdgeKind, number>;
  fileDamp: number;
}

export const DEFAULT_STRATEGY: Strategy = {
  hops: 2,
  decay: 0.65,
  weights: { calls: 1.0, extends: 0.9, references: 0.7, imports: 0.4 },
  fileDamp: 0.5,
};

export const DEFAULT_BUDGET = 8000;

/**
 * Where to read source text from (#11): a single root (single-repo db, the
 * historical shape) or a per-repo resolver backed by the repos table.
 */
export type RootResolver = string | ((repo: string) => string | null);

function rootOf(roots: RootResolver, repo: string): string | null {
  return typeof roots === 'function' ? roots(repo) : roots;
}

export interface Seed {
  symbol: SymbolRow;
  via: 'span-overlap' | 'file-fallback';
}

export interface ContextItem {
  id: string;
  repo: string;
  name: string;
  kind: string;
  file: string;
  span: [number, number];
  score: number;
  /** e.g. "seed", "←calls", "→calls·→references" (path from nearest seed) */
  via: string;
  chars: number;
  text?: string;
}

export interface ContextPack {
  seeds: ContextItem[];
  /** ranked, budget-packed non-seed context */
  items: ContextItem[];
  /** ranked items that did not fit the budget */
  elided: { id: string; name: string; file: string; score: number }[];
  unknownFiles: string[];
  budget: number;
  usedChars: number;
  /** diff signature + the strategy that produced this pack (§4-⑤ logging) */
  signature: string;
  strategy: Strategy;
  strategyFromCache: boolean;
}

/**
 * Deterministic "shape of the diff" (§4-⑤: diffシグネチャ → 探索戦略).
 * Coarse on purpose so patterns repeat: seed kinds, top-level dirs (2 path
 * segments), whether tests are touched, and a bucketed seed count.
 */
export function diffSignature(seeds: Seed[], unknownFiles: string[]): string {
  const kinds = [...new Set(seeds.map((s) => s.symbol.kind))].sort();
  const dirs = [
    ...new Set(
      seeds.map((s) => s.symbol.file.split('/').slice(0, -1).slice(0, 2).join('/') || '.')
    ),
  ].sort();
  const tests = seeds.some(
    (s) =>
      s.symbol.kind === 'testblock' || /\.(test|spec)\.[jt]sx?$|_test\.go$|Test\.php$/.test(s.symbol.file)
  );
  const n = seeds.length;
  const bucket = n <= 1 ? '1' : n <= 2 ? '2' : n <= 5 ? '3-5' : '6+';
  const unknown = unknownFiles.length > 0 ? 1 : 0;
  return `k=${kinds.join(',')}|d=${dirs.join(',')}|t=${tests ? 1 : 0}|n=${bucket}|u=${unknown}`;
}

/**
 * Map diff hunks to seed symbols: span overlap first, module fallback second.
 * `repo` scopes path lookup when two repos in the db share a path (#11) —
 * a diff always belongs to one repository.
 */
export function seedsFromDiff(
  store: Store,
  hunks: FileRanges[],
  repo?: string
): { seeds: Seed[]; unknownFiles: string[] } {
  const seeds = new Map<string, Seed>();
  const unknownFiles: string[] = [];
  for (const { file, ranges } of hunks) {
    const symbols = store.symbolsInFile(file, repo);
    if (symbols.length === 0) {
      unknownFiles.push(file);
      continue;
    }
    const nonModule = symbols.filter((s) => s.kind !== 'module');
    let hit = false;
    for (const s of nonModule) {
      if (ranges.some(([a, b]) => s.spanStart <= b && s.spanEnd >= a)) {
        seeds.set(s.id, { symbol: s, via: 'span-overlap' });
        hit = true;
      }
    }
    if (!hit) {
      const mod = symbols.find((s) => s.kind === 'module');
      if (mod) seeds.set(mod.id, { symbol: mod, via: 'file-fallback' });
    }
  }
  return { seeds: [...seeds.values()], unknownFiles };
}

interface Candidate {
  symbol: SymbolRow;
  score: number;
  via: string;
}

/**
 * Weighted BFS from the seeds, then greedy packing by score until `budget`
 * characters of source are spent. Seeds are always included (and charged).
 */
export function expandContext(
  store: Store,
  roots: RootResolver,
  seeds: Seed[],
  opts: { strategy?: Strategy; hops?: number; budget?: number; withSource?: boolean } = {}
): ContextPack {
  const strategy = opts.strategy ?? DEFAULT_STRATEGY;
  const hops = opts.hops ?? strategy.hops;
  const budget = opts.budget ?? DEFAULT_BUDGET;

  const best = new Map<string, Candidate>();
  let frontier: Candidate[] = seeds.map((s) => ({ symbol: s.symbol, score: 1, via: 'seed' }));
  const seedIds = new Set(seeds.map((s) => s.symbol.id));
  for (const c of frontier) best.set(c.symbol.id, c);

  for (let depth = 0; depth < hops; depth++) {
    const next: Candidate[] = [];
    for (const cur of frontier) {
      const { out, in: inc } = store.edgesOf(cur.symbol.id);
      for (const [edges, dir] of [[out, '→'], [inc, '←']] as const) {
        for (const e of edges) {
          if (!e.resolved) continue;
          const otherId = dir === '→' ? e.toId! : e.fromId;
          const score = cur.score * strategy.weights[e.kind] * strategy.decay;
          const known = best.get(otherId);
          if (known && known.score >= score) continue;
          const sym = known?.symbol ?? store.symbolById(otherId);
          if (!sym) continue;
          const via = cur.via === 'seed' ? `${dir}${e.kind}` : `${cur.via}·${dir}${e.kind}`;
          const cand = { symbol: sym, score, via };
          best.set(otherId, cand);
          next.push(cand);
        }
      }
    }
    frontier = next;
  }

  const sourceOf = (s: SymbolRow): string => {
    const root = rootOf(roots, s.repo);
    if (root === null) return '';
    try {
      const lines = readFileSync(join(root, s.file), 'utf8').split('\n');
      return lines.slice(s.spanStart - 1, s.spanEnd).join('\n');
    } catch {
      return '';
    }
  };

  const toItem = (c: Candidate, withSource: boolean): ContextItem => {
    const text = sourceOf(c.symbol);
    return {
      id: c.symbol.id,
      repo: c.symbol.repo,
      name: c.symbol.container ? `${c.symbol.container}.${c.symbol.name}` : c.symbol.name,
      kind: c.symbol.kind,
      file: c.symbol.file,
      span: [c.symbol.spanStart, c.symbol.spanEnd],
      score: Math.round(c.score * 1000) / 1000,
      via: c.via,
      chars: text.length,
      ...(withSource ? { text } : {}),
    };
  };

  const withSource = opts.withSource ?? false;
  const seedItems = seeds.map((s) => toItem({ symbol: s.symbol, score: 1, via: 'seed' }, withSource));
  // Seeds are NOT charged against the budget: the changed code is already
  // carried by the diff itself — the budget governs *retrieved* context only.
  // Charging seeds let hub-symbol diffs starve retrieval (Phase-0 report,
  // wyt-012).
  let used = 0;

  const pool = [...best.values()]
    .filter((c) => !seedIds.has(c.symbol.id))
    .map((c) => ({ c, cost: sourceOf(c.symbol).length }));

  // Greedy packing with per-file diminishing returns: each item already
  // packed from a file halves the effective score of that file's remaining
  // candidates. Without this, swarms of cheap same-file items (test blocks)
  // crowd out structurally distinct context (Phase-0 report follow-up).
  // Ties break by cost asc (more context per char), then name (determinism).
  const items: ContextItem[] = [];
  const elided: ContextPack['elided'] = [];
  const perFile = new Map<string, number>();
  while (pool.length > 0) {
    let bestIdx = -1;
    let bestEff = -1;
    let bestCost = Infinity;
    for (let i = 0; i < pool.length; i++) {
      const { c, cost } = pool[i];
      const eff = c.score * strategy.fileDamp ** (perFile.get(c.symbol.file) ?? 0);
      if (
        eff > bestEff ||
        (eff === bestEff &&
          (cost < bestCost ||
            (cost === bestCost && c.symbol.name.localeCompare(pool[bestIdx].c.symbol.name) < 0)))
      ) {
        bestIdx = i;
        bestEff = eff;
        bestCost = cost;
      }
    }
    const [{ c, cost }] = pool.splice(bestIdx, 1);
    const item = toItem(c, withSource);
    if (used + cost <= budget) {
      items.push(item);
      used += cost;
      perFile.set(c.symbol.file, (perFile.get(c.symbol.file) ?? 0) + 1);
    } else {
      elided.push({ id: item.id, name: item.name, file: item.file, score: item.score });
    }
  }

  return {
    seeds: seedItems,
    items,
    elided,
    unknownFiles: [],
    budget,
    usedChars: used,
    signature: diffSignature(seeds, []),
    strategy,
    strategyFromCache: false,
  };
}

/**
 * Full pipeline: diff → seeds → (PatternCache lookup by signature, §4-⑤)
 * → weighted expansion. An explicit opts.strategy always wins; useCache
 * falls back to DEFAULT_STRATEGY on a cache miss — the deterministic
 * pipeline is the base, cached strategies are the learned overrides (ADR-3).
 */
export function retrieveForDiff(
  store: Store,
  roots: RootResolver,
  hunks: FileRanges[],
  opts: { strategy?: Strategy; useCache?: boolean; hops?: number; budget?: number; withSource?: boolean; repo?: string } = {}
): ContextPack {
  const { seeds, unknownFiles } = seedsFromDiff(store, hunks, opts.repo);
  const signature = diffSignature(seeds, unknownFiles);

  let strategy = opts.strategy;
  let fromCache = false;
  if (!strategy && opts.useCache) {
    const cached = store.getPattern(signature);
    if (cached) {
      strategy = JSON.parse(cached.strategy) as Strategy;
      fromCache = true;
    }
  }

  const pack = expandContext(store, roots, seeds, { ...opts, strategy });
  pack.unknownFiles = unknownFiles;
  pack.signature = signature;
  pack.strategyFromCache = fromCache;
  return pack;
}
