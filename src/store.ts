/**
 * Knowledge Store — the single-SQLite backbone (architecture §4-②, ADR-1).
 *
 * Three roles in one file: RDB (files/symbols), Graph (edges + recursive CTE),
 * Vector (deferred — sqlite-vec lands with the semantic layer; the schema
 * reserves nothing for it so it can be added as a separate table later).
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type SymbolKind =
  | 'module'
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'typealias'
  | 'enum'
  | 'variable'
  | 'testblock';

export type EdgeKind = 'calls' | 'imports' | 'extends' | 'references';

export interface SymbolRow {
  id: string;
  kind: SymbolKind;
  name: string;
  file: string;
  container: string | null;
  spanStart: number;
  spanEnd: number;
  signature: string | null;
  doc: string | null;
}

export interface EdgeRow {
  fromId: string;
  toId: string | null;
  toName: string;
  kind: EdgeKind;
  resolved: boolean;
}

export interface NeighborRow extends SymbolRow {
  depth: number;
  edgeKind: EdgeKind;
  direction: 'out' | 'in';
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  path       TEXT PRIMARY KEY,
  hash       TEXT NOT NULL,
  indexed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS symbols (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  name       TEXT NOT NULL,
  file       TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  container  TEXT,
  span_start INTEGER NOT NULL,
  span_end   INTEGER NOT NULL,
  signature  TEXT,
  doc        TEXT
);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file);
CREATE TABLE IF NOT EXISTS edges (
  from_id  TEXT NOT NULL,
  to_id    TEXT NOT NULL DEFAULT '',
  to_name  TEXT NOT NULL,
  kind     TEXT NOT NULL,
  resolved INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id, to_name, kind)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id) WHERE to_id != '';
`;

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  fileHash(path: string): string | null {
    const row = this.db.prepare('SELECT hash FROM files WHERE path = ?').get(path) as
      | { hash: string }
      | undefined;
    return row?.hash ?? null;
  }

  /** Replace a file's rows wholesale: its symbols, and edges originating from them. */
  replaceFile(path: string, hash: string, symbols: SymbolRow[], edges: EdgeRow[]): void {
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(`DELETE FROM edges WHERE from_id IN (SELECT id FROM symbols WHERE file = ?)`)
        .run(path);
      this.db.prepare('DELETE FROM symbols WHERE file = ?').run(path);
      this.db
        .prepare(
          'INSERT INTO files(path, hash, indexed_at) VALUES(?, ?, ?) ON CONFLICT(path) DO UPDATE SET hash = excluded.hash, indexed_at = excluded.indexed_at'
        )
        .run(path, hash, Date.now());
      const insSym = this.db.prepare(
        'INSERT OR REPLACE INTO symbols(id, kind, name, file, container, span_start, span_end, signature, doc) VALUES(?,?,?,?,?,?,?,?,?)'
      );
      for (const s of symbols) {
        insSym.run(s.id, s.kind, s.name, s.file, s.container, s.spanStart, s.spanEnd, s.signature, s.doc);
      }
      const insEdge = this.db.prepare(
        'INSERT OR IGNORE INTO edges(from_id, to_id, to_name, kind, resolved) VALUES(?,?,?,?,?)'
      );
      for (const e of edges) {
        insEdge.run(e.fromId, e.toId ?? '', e.toName, e.kind, e.resolved ? 1 : 0);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  removeFiles(paths: string[]): void {
    const delEdges = this.db.prepare(
      'DELETE FROM edges WHERE from_id IN (SELECT id FROM symbols WHERE file = ?)'
    );
    const delFile = this.db.prepare('DELETE FROM files WHERE path = ?');
    for (const p of paths) {
      delEdges.run(p);
      delFile.run(p);
    }
  }

  listFiles(): { path: string; hash: string }[] {
    return this.db.prepare('SELECT path, hash FROM files ORDER BY path').all() as {
      path: string;
      hash: string;
    }[];
  }

  stats(): { files: number; symbols: number; edges: number; unresolvedEdges: number; byKind: Record<string, number> } {
    const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    const byKind: Record<string, number> = {};
    for (const row of this.db
      .prepare('SELECT kind, COUNT(*) AS n FROM symbols GROUP BY kind ORDER BY n DESC')
      .all() as { kind: string; n: number }[]) {
      byKind[row.kind] = row.n;
    }
    return {
      files: one('SELECT COUNT(*) AS n FROM files'),
      symbols: one('SELECT COUNT(*) AS n FROM symbols'),
      edges: one('SELECT COUNT(*) AS n FROM edges'),
      unresolvedEdges: one('SELECT COUNT(*) AS n FROM edges WHERE resolved = 0'),
      byKind,
    };
  }

  findSymbols(query: string, limit = 20): SymbolRow[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM symbols
           WHERE name = ?1 OR name LIKE ?2 OR (container || '.' || name) = ?1
           ORDER BY CASE WHEN name = ?1 THEN 0 ELSE 1 END, file, span_start
           LIMIT ?3`
        )
        .all(query, `%${query}%`, limit) as unknown[]
    ).map(rowToSymbol);
  }

  symbolsInFile(file: string): SymbolRow[] {
    return (
      this.db
        .prepare('SELECT * FROM symbols WHERE file = ? ORDER BY span_start')
        .all(file) as unknown[]
    ).map(rowToSymbol);
  }

  /**
   * k-hop neighborhood via recursive CTE (ADR-1: graph role of SQLite).
   * Walks outgoing and incoming resolved edges from a seed symbol.
   */
  neighborhood(seedId: string, hops: number, limit = 200): NeighborRow[] {
    const sql = `
      WITH RECURSIVE walk(id, depth, edge_kind, direction) AS (
        SELECT ?1, 0, '', ''
        UNION
        SELECT CASE WHEN e.from_id = w.id THEN e.to_id ELSE e.from_id END,
               w.depth + 1,
               e.kind,
               CASE WHEN e.from_id = w.id THEN 'out' ELSE 'in' END
        FROM edges e
        JOIN walk w ON (e.from_id = w.id OR e.to_id = w.id)
        WHERE w.depth < ?2 AND e.resolved = 1 AND e.to_id != ''
      )
      SELECT s.*, MIN(w.depth) AS depth, w.edge_kind AS edge_kind, w.direction AS direction
      FROM walk w JOIN symbols s ON s.id = w.id
      WHERE w.depth > 0
      GROUP BY s.id
      ORDER BY depth, s.file, s.span_start
      LIMIT ?3`;
    return (this.db.prepare(sql).all(seedId, hops, limit) as Record<string, unknown>[]).map((r) => ({
      ...rowToSymbol(r),
      depth: r.depth as number,
      edgeKind: r.edge_kind as EdgeKind,
      direction: r.direction as 'out' | 'in',
    }));
  }

  edgesOf(id: string): { out: EdgeRow[]; in: EdgeRow[] } {
    const map = (r: Record<string, unknown>): EdgeRow => ({
      fromId: r.from_id as string,
      toId: (r.to_id as string) === '' ? null : (r.to_id as string),
      toName: r.to_name as string,
      kind: r.kind as EdgeKind,
      resolved: (r.resolved as number) === 1,
    });
    return {
      out: (this.db.prepare('SELECT * FROM edges WHERE from_id = ?').all(id) as Record<string, unknown>[]).map(map),
      in: (this.db.prepare("SELECT * FROM edges WHERE to_id = ? AND to_id != ''").all(id) as Record<string, unknown>[]).map(map),
    };
  }

  symbolById(id: string): SymbolRow | null {
    const row = this.db.prepare('SELECT * FROM symbols WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToSymbol(row) : null;
  }
}

function rowToSymbol(r: unknown): SymbolRow {
  const row = r as Record<string, unknown>;
  return {
    id: row.id as string,
    kind: row.kind as SymbolKind,
    name: row.name as string,
    file: row.file as string,
    container: (row.container as string | null) ?? null,
    spanStart: row.span_start as number,
    spanEnd: row.span_end as number,
    signature: (row.signature as string | null) ?? null,
    doc: (row.doc as string | null) ?? null,
  };
}
