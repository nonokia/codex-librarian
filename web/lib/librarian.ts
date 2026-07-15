/**
 * Server-side bridge to the knowledge store. The web app never reimplements
 * store logic — it imports the parent package's compiled output (run
 * `npm run build` at the repo root first).
 *
 * DB selection: LIBRARIAN_DB env var, else <repo root>/.librarian/index.db.
 * Source roots come from the repos table (multi-repo, #11); LIBRARIAN_REPO
 * overrides them all — useful when the recorded root is not on this machine.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store, type RepoRow } from '../../dist/store/store.js';

export interface Librarian {
  store: Store;
  dbPath: string;
  repos: RepoRow[];
  rootFor: (repo: string) => string | null;
}

let cached: Librarian | null = null;

export function openLibrarian(): Librarian {
  if (cached) return cached;
  const dbPath = resolve(process.env.LIBRARIAN_DB ?? '../.librarian/index.db');
  if (!existsSync(dbPath)) {
    throw new Error(
      `no index at ${dbPath} — run \`librarian index <repo>\` first and point LIBRARIAN_DB at the db`
    );
  }
  const store = new Store(dbPath);
  const repos = store.listRepos();
  const override = process.env.LIBRARIAN_REPO;
  if (repos.length === 0 && !override) {
    throw new Error('index has no repos recorded — re-run `librarian index <repo>` (or set LIBRARIAN_REPO)');
  }
  const roots = new Map(repos.map((r) => [r.name, r.root]));
  const rootFor = (repo: string) => override ?? roots.get(repo) ?? null;
  cached = { store, dbPath, repos, rootFor };
  return cached;
}

export type { SymbolRow, NeighborRow, RepoRow } from '../../dist/store/store.js';

// The deterministic retrieval pipeline (ADR-3): the web app shares the CLI's
// single budget-allocation path instead of reimplementing it (#41).
export { expandContext } from '../../dist/core/retrieval.js';
export type { Seed, ContextItem, ContextPack, Demote } from '../../dist/core/retrieval.js';
