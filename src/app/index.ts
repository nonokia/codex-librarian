/**
 * Extractor dispatch (#10) — discovers files, routes each to the first
 * registered extractor claiming its extension, and merges every extractor's
 * rows into the same store (`librarian index` / `librarian import`).
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import type { ExtractionResult, Extractor } from '../protocol/extractor.js';
import { scipIndexToExtractionResults, scipPlusToExtractionResults } from '../protocol/scip-ingest.js';
import { decodeScip, parseExt } from '../protocol/scip.js';
import { EXTENSIONS, TypeScriptExtractor } from '../extractors/ts.js';
import { GoExtractor } from '../extractors/go.js';
import { PhpExtractor } from '../extractors/php.js';
import { Store } from '../store/store.js';

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.dlog', '.librarian', 'out', 'vendor']);

/**
 * The extractor registry (#10). Language support = appending here; the store,
 * retrieval, and UI never learn which extractor produced a row. When two
 * extractors claim the same extension, the first registered wins.
 */
export function defaultExtractors(): Extractor[] {
  return [new TypeScriptExtractor(), new GoExtractor(), new PhpExtractor()];
}

export function discoverSourceFiles(rootDir: string, extensions: string[] = EXTENSIONS): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.name !== '.') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (extensions.some((ext) => entry.name.endsWith(ext)) && !entry.name.endsWith('.d.ts')) {
        found.push(full);
      }
    }
  };
  walk(rootDir);
  return found.sort();
}

/** first registered extractor claiming the file's extension, or null */
function extractorFor(file: string, extractors: Extractor[]): Extractor | null {
  return extractors.find((x) => x.extensions.some((ext) => file.endsWith(ext))) ?? null;
}

export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * Namespace extractor-local symbol ids with the repo (#11). Extractors hash
 * only file::container::name::kind (the Go/PHP binaries share that scheme),
 * so two repos containing the same path would collide in one db; folding the
 * repo in here keeps every language binary unchanged.
 */
function namespaceIds(repo: string, results: ExtractionResult[]): ExtractionResult[] {
  const remap = new Map<string, string>();
  for (const r of results) {
    for (const s of r.symbols) {
      remap.set(s.id, createHash('sha256').update(`${repo}::${s.id}`).digest('hex').slice(0, 20));
    }
  }
  return results.map((r) => ({
    file: r.file,
    symbols: r.symbols.map((s) => ({ ...s, id: remap.get(s.id)! })),
    edges: r.edges.map((e) => ({
      ...e,
      fromId: remap.get(e.fromId) ?? e.fromId,
      toId: e.toId === null ? null : (remap.get(e.toId) ?? e.toId),
    })),
  }));
}

export interface IndexReport {
  repo: string;
  root: string;
  filesSeen: number;
  filesIndexed: number;
  filesUnchanged: number;
  filesRemoved: number;
  symbols: number;
  edges: number;
  unresolvedEdges: number;
  durationMs: number;
}

/**
 * Index `rootDir` into `store`. Incremental at the persistence layer: rows are
 * rewritten only for files whose content hash changed (parse is still whole-
 * program per extractor — cross-file resolution needs it; see dlog for the
 * deferral).
 *
 * Dispatch (#10): files are discovered for the union of the registered
 * extractors' extensions, routed to the first extractor that claims them,
 * and every extractor's rows merge into the same store. An extractor only
 * runs when at least one of ITS files changed.
 *
 * Jurisdiction (#16 §4.5): a run only manages — and in particular only
 * REMOVES — files its extractors claim. Rows of other extensions (e.g. .py
 * imported from an external .scip) survive a reindex, so `index` and
 * `import` can coexist in one repo.
 */
export function indexRepo(
  store: Store,
  rootDir: string,
  opts: { extractors?: Extractor[]; include?: string[]; repoName?: string } = {}
): IndexReport {
  const t0 = Date.now();
  const repo = opts.repoName ?? basename(resolve(rootDir));
  const extractors = opts.extractors ?? defaultExtractors();
  const allExtensions = [...new Set(extractors.flatMap((x) => x.extensions))];
  const rel = (abs: string) => relative(rootDir, abs).split(sep).join('/');
  // --include: keep only files under the given root-relative prefixes
  // (directory-boundary aware, so `src` does not match `src2/`).
  const prefixes = opts.include?.map((p) => p.replace(/\/+$/, ''));
  const included = (abs: string) => {
    if (!prefixes || prefixes.length === 0) return true;
    const r = rel(abs);
    return prefixes.some((p) => r === p || r.startsWith(`${p}/`));
  };
  const absFiles = discoverSourceFiles(rootDir, allExtensions).filter(included);

  const hashes = new Map<string, string>();
  for (const abs of absFiles) hashes.set(rel(abs), contentHash(readFileSync(abs, 'utf8')));

  const known = new Map(store.listFiles(repo).map((f) => [f.path, f.hash]));
  const removed = [...known.keys()].filter(
    (p) => !hashes.has(p) && extractorFor(p, extractors) !== null
  );
  store.removeFiles(repo, removed);

  const changedSet = new Set(
    [...hashes.entries()].filter(([p, h]) => known.get(p) !== h).map(([p]) => p)
  );

  // The repos row must exist before any files row references it (FK), but a
  // no-op reindex must not touch the db at all (byte-identity, #15) — so the
  // upsert only happens when this run will actually write.
  const existing = store.getRepo(repo);
  if (changedSet.size > 0 || removed.length > 0 || !existing || existing.root !== rootDir) {
    store.upsertRepo(repo, rootDir);
  }

  let indexed = 0;
  for (const extractor of extractors) {
    const claimed = absFiles.filter((abs) => extractorFor(rel(abs), extractors) === extractor);
    if (claimed.length === 0 || !claimed.some((abs) => changedSet.has(rel(abs)))) continue;
    for (const r of namespaceIds(repo, extractor.extract(rootDir, claimed))) {
      if (!changedSet.has(r.file)) continue;
      store.replaceFile(repo, r.file, hashes.get(r.file)!, r.symbols, r.edges);
      indexed++;
    }
  }
  if (indexed > 0 || removed.length > 0 || !existing || existing.root !== rootDir) {
    store.setMeta('last_indexed_at', String(Date.now()));
  }

  const s = store.stats();
  return {
    repo,
    root: rootDir,
    filesSeen: absFiles.length,
    filesIndexed: indexed,
    filesUnchanged: absFiles.length - indexed,
    filesRemoved: removed.length,
    symbols: s.symbols,
    edges: s.edges,
    unresolvedEdges: s.unresolvedEdges,
    durationMs: Date.now() - t0,
  };
}

export interface ScipImportReport extends IndexReport {
  /** true when no ext sidecar was found and edges were degrade-derived (§4.5) */
  degraded: boolean;
  skippedSymbols: number;
  /** degrade-route documents dropped because a native extractor claims their extension (§4.5 dispatch) */
  skippedNativeFiles: number;
}

/**
 * Import a `.scip` file into the store (issue #16 Step 4 — the external
 * intake, `librarian import`). A `<base>.scip-ext.json` sidecar next to the
 * file selects the full SCIP+ ingest; without one, edges degrade-derive from
 * base occurrences (design §4.5). Persistence mirrors indexRepo — repo
 * namespacing of ids happens here and only here (multi-repo invariant) — but
 * file hashes cover the rows, not file contents: the source tree may not
 * exist on this machine.
 *
 * Dispatch (#16 §4.5, Step 5): native always wins. On the degrade route,
 * documents whose extension a registered extractor claims are skipped —
 * `librarian index` is the richer intake for those languages. The sidecar
 * route is exempt: ext IS the native signal (the export --scip roundtrip).
 * Removal jurisdiction mirrors indexRepo: an import only removes files of
 * extensions it actually ingested, so native rows survive a re-import.
 */
export function importScip(
  store: Store,
  scipPath: string,
  opts: { repoName?: string; root?: string; extractors?: Extractor[] } = {}
): ScipImportReport {
  const t0 = Date.now();
  const index = decodeScip(readFileSync(scipPath));
  const base = scipPath.endsWith('.scip') ? scipPath.slice(0, -'.scip'.length) : scipPath;
  const extPath = base + '.scip-ext.json';

  let raw: ExtractionResult[];
  let degraded: boolean;
  let skippedSymbols = 0;
  if (existsSync(extPath)) {
    const ext = parseExt(JSON.parse(readFileSync(extPath, 'utf8')));
    raw = scipPlusToExtractionResults(index, ext);
    degraded = false;
  } else {
    const d = scipIndexToExtractionResults(index);
    raw = d.results;
    skippedSymbols = d.skippedSymbols;
    degraded = true;
  }

  let skippedNativeFiles = 0;
  if (degraded) {
    const extractors = opts.extractors ?? defaultExtractors();
    const kept = raw.filter((r) => extractorFor(r.file, extractors) === null);
    skippedNativeFiles = raw.length - kept.length;
    raw = kept;
  }

  const projectRoot = index.metadata?.projectRoot.replace(/^file:\/\//, '') ?? '';
  const root = resolve(opts.root ?? (projectRoot || dirname(resolve(scipPath))));
  const repo = opts.repoName ?? basename(root);
  const results = namespaceIds(repo, raw);

  const known = new Map(store.listFiles(repo).map((f) => [f.path, f.hash]));
  const present = new Set(results.map((r) => r.file));
  const importedExts = new Set(results.map((r) => extname(r.file)));
  const removed = [...known.keys()].filter((p) => !present.has(p) && importedExts.has(extname(p)));
  store.removeFiles(repo, removed);
  const changed = results
    .map((r) => ({ r, hash: contentHash(JSON.stringify([r.symbols, r.edges])) }))
    .filter(({ r, hash }) => known.get(r.file) !== hash);

  const existing = store.getRepo(repo);
  const writes =
    changed.length > 0 ||
    removed.length > 0 ||
    (results.length > 0 && (!existing || existing.root !== root));
  if (writes) store.upsertRepo(repo, root);
  for (const { r, hash } of changed) store.replaceFile(repo, r.file, hash, r.symbols, r.edges);
  if (writes) store.setMeta('last_indexed_at', String(Date.now()));

  const s = store.stats();
  return {
    repo,
    root,
    degraded,
    skippedSymbols,
    skippedNativeFiles,
    filesSeen: results.length,
    filesIndexed: changed.length,
    filesUnchanged: results.length - changed.length,
    filesRemoved: removed.length,
    symbols: s.symbols,
    edges: s.edges,
    unresolvedEdges: s.unresolvedEdges,
    durationMs: Date.now() - t0,
  };
}
