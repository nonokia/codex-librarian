/**
 * Server-side bridge to the knowledge store. The web app never reimplements
 * store logic — it imports the parent package's compiled output (run
 * `npm run build` at the repo root first).
 *
 * DB selection: LIBRARIAN_DB env var, else <repo root>/.librarian/index.db.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from '../../dist/store.js';

let cached: { store: Store; dbPath: string; root: string } | null = null;

export function openLibrarian(): { store: Store; dbPath: string; root: string } {
  if (cached) return cached;
  const dbPath = resolve(process.env.LIBRARIAN_DB ?? '../.librarian/index.db');
  if (!existsSync(dbPath)) {
    throw new Error(
      `no index at ${dbPath} — run \`librarian index <repo>\` first and point LIBRARIAN_DB at the db`
    );
  }
  const store = new Store(dbPath);
  const root = process.env.LIBRARIAN_REPO ?? store.getMeta('root');
  if (!root) throw new Error('index has no recorded root — set LIBRARIAN_REPO');
  cached = { store, dbPath, root };
  return cached;
}

export type { SymbolRow, NeighborRow } from '../../dist/store.js';
