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

export const EDGE_WEIGHTS: Record<EdgeKind, number> = {
  calls: 1.0,
  extends: 0.9,
  references: 0.7,
  imports: 0.4,
};
export const HOP_DECAY = 0.65;
export const DEFAULT_BUDGET = 8000;
export const DEFAULT_HOPS = 2;

export interface Seed {
  symbol: SymbolRow;
  via: 'span-overlap' | 'file-fallback';
}

export interface ContextItem {
  id: string;
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
}

/** Map diff hunks to seed symbols: span overlap first, module fallback second. */
export function seedsFromDiff(store: Store, hunks: FileRanges[]): { seeds: Seed[]; unknownFiles: string[] } {
  const seeds = new Map<string, Seed>();
  const unknownFiles: string[] = [];
  for (const { file, ranges } of hunks) {
    const symbols = store.symbolsInFile(file);
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
  rootDir: string,
  seeds: Seed[],
  opts: { hops?: number; budget?: number; withSource?: boolean } = {}
): ContextPack {
  const hops = opts.hops ?? DEFAULT_HOPS;
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
          const score = cur.score * EDGE_WEIGHTS[e.kind] * HOP_DECAY;
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
    try {
      const lines = readFileSync(join(rootDir, s.file), 'utf8').split('\n');
      return lines.slice(s.spanStart - 1, s.spanEnd).join('\n');
    } catch {
      return '';
    }
  };

  const toItem = (c: Candidate, withSource: boolean): ContextItem => {
    const text = sourceOf(c.symbol);
    return {
      id: c.symbol.id,
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

  const ranked = [...best.values()]
    .filter((c) => !seedIds.has(c.symbol.id))
    .map((c) => ({ c, cost: sourceOf(c.symbol).length }))
    // score desc; ties broken by cost asc (more context per char), then name
    // for full determinism — arbitrary tie order was the other half of the
    // wyt-012 failure.
    .sort(
      (a, b) =>
        b.c.score - a.c.score || a.cost - b.cost || a.c.symbol.name.localeCompare(b.c.symbol.name)
    )
    .map(({ c }) => c);

  const items: ContextItem[] = [];
  const elided: ContextPack['elided'] = [];
  for (const c of ranked) {
    const item = toItem(c, withSource);
    if (used + item.chars <= budget) {
      items.push(item);
      used += item.chars;
    } else {
      elided.push({ id: item.id, name: item.name, file: item.file, score: item.score });
    }
  }

  return { seeds: seedItems, items, elided, unknownFiles: [], budget, usedChars: used };
}

export function retrieveForDiff(
  store: Store,
  rootDir: string,
  hunks: FileRanges[],
  opts: { hops?: number; budget?: number; withSource?: boolean } = {}
): ContextPack {
  const { seeds, unknownFiles } = seedsFromDiff(store, hunks);
  const pack = expandContext(store, rootDir, seeds, opts);
  pack.unknownFiles = unknownFiles;
  return pack;
}
