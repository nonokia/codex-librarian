/**
 * SCIP+ export — store rows back out through the emit mapping, for the
 * `.scip` + `.scip-ext.json` file boundary (docs/scip-design.md §4.1;
 * `librarian export --scip`, issue #16 Step 4).
 *
 * Reuses extractionResultsToScipPlus, whose base layer for row-level input is
 * definition occurrences only (rows carry no reference positions — see the
 * scip-emit.ts module comment); ext carries every edge, so an exported
 * envelope re-ingests to the exact same rows. Emit needs one moniker scheme
 * per call, so a mixed-language repo is partitioned by extension and merged
 * back; ToolInfo names `librarian` (the store is the producer, not one of the
 * language extractors — schemes stay per-document in the monikers).
 */
import { extname } from 'node:path';
import { TextEncoding } from '@scip-code/scip';
import type { Index } from '@scip-code/scip';
import type { Store } from '../store/store.js';
import type { ExtractionResult } from './extractor.js';
import { extractionResultsToScipPlus } from './scip-emit.js';
import { createScipIndex, type Ext, type ExtDocument, type LibrarianScheme } from './scip.js';

const SCHEME_BY_EXTENSION: Record<string, LibrarianScheme> = {
  '.ts': 'librarian-ts',
  '.tsx': 'librarian-ts',
  '.mts': 'librarian-ts',
  '.cts': 'librarian-ts',
  '.js': 'librarian-ts',
  '.jsx': 'librarian-ts',
  '.mjs': 'librarian-ts',
  '.cjs': 'librarian-ts',
  '.go': 'librarian-go',
  '.php': 'librarian-php',
};

export interface ScipExportResult {
  index: Index;
  ext: Ext;
  files: number;
  symbols: number;
  edges: number;
  /**
   * Files whose extension maps to no librarian moniker scheme (e.g. rows that
   * came in from an external `.scip`) — reported, never silently dropped.
   * Round-tripping those is the original external index's job.
   */
  skipped: string[];
}

export function storeToScipPlus(store: Store, repo: string): ScipExportResult {
  const repoRow = store.getRepo(repo);
  if (repoRow === null) throw new Error(`no repo "${repo}" in this index`);

  const byScheme = new Map<LibrarianScheme, ExtractionResult[]>();
  const skipped: string[] = [];
  let symbols = 0;
  let edges = 0;
  const paths = store
    .listFiles(repo)
    .map((f) => f.path)
    .sort();
  for (const path of paths) {
    const scheme = SCHEME_BY_EXTENSION[extname(path)];
    if (scheme === undefined) {
      skipped.push(path);
      continue;
    }
    const rows = store.symbolsInFile(path, repo).map(({ repo: _repo, ...s }) => s);
    const fileEdges = store.edgesFromFile(repo, path);
    symbols += rows.length;
    edges += fileEdges.length;
    const results = byScheme.get(scheme) ?? [];
    results.push({ file: path, symbols: rows, edges: fileEdges });
    byScheme.set(scheme, results);
  }

  // One emit per scheme: emit's moniker table must see every document of its
  // language (edges cross documents). Merged back sorted by path so document
  // order does not depend on the partition.
  const documents: Index['documents'] = [];
  const extDocuments: ExtDocument[] = [];
  for (const scheme of [...byScheme.keys()].sort()) {
    const emitted = extractionResultsToScipPlus(scheme, repoRow.root, byScheme.get(scheme)!);
    documents.push(...emitted.index.documents);
    extDocuments.push(...emitted.ext.documents);
  }
  const byPath = (a: { relativePath: string }, b: { relativePath: string }) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0;
  documents.sort(byPath);
  extDocuments.sort(byPath);

  const index = createScipIndex({
    metadata: {
      toolInfo: { name: 'librarian', version: '0.1.0' },
      projectRoot: 'file://' + repoRow.root,
      textDocumentEncoding: TextEncoding.UTF8,
    },
    documents,
  });
  return {
    index,
    ext: { version: 1, documents: extDocuments },
    files: paths.length - skipped.length,
    symbols,
    edges,
    skipped,
  };
}
