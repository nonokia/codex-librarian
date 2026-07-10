/**
 * Extractor interface — the language seam (architecture §4-①, ADR-2).
 *
 * v1 ships exactly one implementation (TypeScript Compiler API, see
 * indexer.ts). Other languages plug in here later (tree-sitter/SCIP based);
 * the store and CLI must never know which extractor produced the rows.
 */
import type { EdgeRow, SymbolRow } from './store.js';

export interface ExtractionResult {
  /** repo-relative file path this result describes */
  file: string;
  symbols: SymbolRow[];
  edges: EdgeRow[];
}

export interface Extractor {
  /** file extensions this extractor claims, e.g. ['.ts', '.tsx'] */
  readonly extensions: string[];
  /**
   * Extract symbols and edges for every claimed file under `rootDir`.
   * Whole-project extraction (not per-file) because reference resolution
   * needs cross-file knowledge.
   */
  extract(rootDir: string, files: string[]): ExtractionResult[];
}
