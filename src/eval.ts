/**
 * Phase-0 evaluation harness (ADR-4): retrieval match rate against a curated
 * golden set. Every retrieval change from here on is justified by these
 * numbers — nothing else in the repo may claim a precision figure.
 *
 * Match rate = micro recall: of all expected context entries across cases,
 * the fraction the retriever actually surfaced within budget. Precision is
 * deliberately NOT reported: the golden expectations are not exhaustive, so
 * "retrieved but not expected" is unknowable, not wrong. Context cost
 * (items/chars) is reported instead as the pressure metric.
 */
import { readFileSync } from 'node:fs';
import type { Store } from './store.js';
import { parseUnifiedDiff } from './diff.js';
import { retrieveForDiff, type ContextItem, type ContextPack, type RootResolver, type Strategy } from './retrieval.js';

export interface ExpectedEntry {
  file: string;
  /** bare symbol name; omitted = any symbol of that file (incl. module) counts */
  symbol?: string;
}

export interface GoldenCase {
  id: string;
  title: string;
  /** provenance note, e.g. the real commit this scenario reenacts */
  note?: string;
  /** unified diff text — the real PR-shaped input */
  diff?: string;
  /**
   * OR: point at a symbol in the indexed tree; the harness synthesizes a
   * one-line hunk at its current span so cases don't rot as lines move.
   */
  target?: { file: string; symbol?: string };
  expected: ExpectedEntry[];
}

export interface CaseResult {
  id: string;
  title: string;
  signature?: string;
  strategyFromCache?: boolean;
  seeds: string[];
  matched: ExpectedEntry[];
  missed: ExpectedEntry[];
  recall: number;
  retrievedItems: number;
  elidedItems: number;
  usedChars: number;
  error?: string;
}

export interface EvalReport {
  cases: CaseResult[];
  aggregate: {
    cases: number;
    microRecall: number;
    macroRecall: number;
    perfectCases: number;
    totalExpected: number;
    totalMatched: number;
    meanItems: number;
    meanChars: number;
  };
  budget: number;
  hops: number;
}

export function loadGoldenFile(path: string): GoldenCase[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const cases: GoldenCase[] = Array.isArray(parsed) ? parsed : parsed.cases;
  for (const c of cases) {
    if (!c.id || !c.expected?.length || (!c.diff && !c.target)) {
      throw new Error(`golden case ${c.id ?? '<no id>'}: need id, expected[], and diff or target`);
    }
  }
  return cases;
}

function hunksForCase(store: Store, c: GoldenCase) {
  if (c.diff) return parseUnifiedDiff(c.diff);
  const t = c.target!;
  const symbols = store.symbolsInFile(t.file);
  if (symbols.length === 0) throw new Error(`target file not in index: ${t.file}`);
  let span: [number, number] = [1, 1];
  if (t.symbol) {
    const s = symbols.find((s) => s.name === t.symbol);
    if (!s) throw new Error(`target symbol not in index: ${t.file}#${t.symbol}`);
    span = [s.spanStart, s.spanEnd];
  }
  return [{ file: t.file, ranges: [span] as [number, number][] }];
}

function matches(item: ContextItem, exp: ExpectedEntry): boolean {
  if (item.file !== exp.file) return false;
  if (!exp.symbol) return true;
  return item.name === exp.symbol || item.name.endsWith(`.${exp.symbol}`);
}

export function runEval(
  store: Store,
  rootDir: RootResolver,
  cases: GoldenCase[],
  opts: { hops?: number; budget?: number; strategy?: Strategy; useCache?: boolean } = {}
): EvalReport {
  const results: CaseResult[] = [];

  for (const c of cases) {
    try {
      const pack: ContextPack = retrieveForDiff(store, rootDir, hunksForCase(store, c), opts);
      const all = [...pack.seeds, ...pack.items];
      // seeds don't count as retrieval wins: the diff already contains them
      const seedIds = new Set(pack.seeds.map((s) => s.id));
      const retrieved = all.filter((i) => !seedIds.has(i.id));
      const matched: ExpectedEntry[] = [];
      const missed: ExpectedEntry[] = [];
      for (const exp of c.expected) {
        (retrieved.some((i) => matches(i, exp)) ? matched : missed).push(exp);
      }
      results.push({
        id: c.id,
        title: c.title,
        signature: pack.signature,
        strategyFromCache: pack.strategyFromCache,
        seeds: pack.seeds.map((s) => s.name),
        matched,
        missed,
        recall: matched.length / c.expected.length,
        retrievedItems: pack.items.length,
        elidedItems: pack.elided.length,
        usedChars: pack.usedChars,
      });
    } catch (err) {
      results.push({
        id: c.id,
        title: c.title,
        seeds: [],
        matched: [],
        missed: c.expected,
        recall: 0,
        retrievedItems: 0,
        elidedItems: 0,
        usedChars: 0,
        error: (err as Error).message,
      });
    }
  }

  const totalExpected = results.reduce((n, r) => n + r.matched.length + r.missed.length, 0);
  const totalMatched = results.reduce((n, r) => n + r.matched.length, 0);
  const round = (x: number) => Math.round(x * 1000) / 1000;
  return {
    cases: results,
    aggregate: {
      cases: results.length,
      microRecall: round(totalExpected ? totalMatched / totalExpected : 0),
      macroRecall: round(results.reduce((n, r) => n + r.recall, 0) / (results.length || 1)),
      perfectCases: results.filter((r) => r.missed.length === 0 && !r.error).length,
      totalExpected,
      totalMatched,
      meanItems: round(results.reduce((n, r) => n + r.retrievedItems, 0) / (results.length || 1)),
      meanChars: Math.round(results.reduce((n, r) => n + r.usedChars, 0) / (results.length || 1)),
    },
    budget: opts.budget ?? 8000,
    hops: opts.hops ?? 2,
  };
}
