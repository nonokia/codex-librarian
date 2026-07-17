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
  | 'struct'
  | 'interface'
  | 'trait'
  | 'typealias'
  | 'enum'
  | 'variable'
  | 'testblock'
  // Terraform (HCL) block kinds (#9). `module` (blocks) and `variable` are
  // reused; these four are new. They carry no call semantics — a Terraform
  // graph is a resource/module reference graph, not a call graph.
  | 'resource'
  | 'data'
  | 'output'
  | 'locals'
  // SQL object kinds (#36). `module` and `function` are reused; like the
  // Terraform kinds these carry no call semantics — the SQL graph is a
  // relation/routine reference graph.
  | 'table'
  | 'view'
  | 'matview'
  | 'procedure'
  | 'trigger'
  | 'index';

export type EdgeKind = 'calls' | 'imports' | 'extends' | 'references' | 'dispatches';

export interface SymbolRow {
  id: string;
  repo: string;
  kind: SymbolKind;
  name: string;
  file: string;
  container: string | null;
  spanStart: number;
  spanEnd: number;
  signature: string | null;
  doc: string | null;
}

export interface RepoRow {
  name: string;
  root: string;
  indexedAt: number;
}

export interface EdgeRow {
  fromId: string;
  toId: string | null;
  toName: string;
  kind: EdgeKind;
  resolved: boolean;
}

/** An unresolved edge with the repo/file it originates in (the input of `link`, #27). */
export interface UnresolvedEdge {
  fromId: string;
  fromRepo: string;
  fromFile: string;
  toName: string;
  kind: EdgeKind;
}

export interface EdgeEndpoint {
  repo: string;
  file: string;
  name: string;
  container: string | null;
  kind: SymbolKind;
}

export interface JoinedEdge {
  kind: EdgeKind;
  from: EdgeEndpoint;
  to: EdgeEndpoint;
}

export interface NeighborRow extends SymbolRow {
  depth: number;
  edgeKind: EdgeKind;
  direction: 'out' | 'in';
}

/** A file node in the collapsed hierarchy view (#28): symbol count per file. */
export interface FileCount {
  repo: string;
  file: string;
  symbols: number;
}

/**
 * One rolled-up edge bundle between two files (#28). Individual symbol→symbol
 * edges are aggregated to file granularity so the graph stays readable at
 * scale. Unresolved edges have no target symbol, so `toRepo`/`toFile` are null.
 */
export interface CollapsedEdge {
  fromRepo: string;
  fromFile: string;
  toRepo: string | null;
  toFile: string | null;
  kind: EdgeKind;
  resolved: boolean;
  count: number;
}

/** Bumped when the table shapes change incompatibly (v2: multi-repo, #11). */
export const SCHEMA_VERSION = '2';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS repos (
  name       TEXT PRIMARY KEY,
  root       TEXT NOT NULL,
  indexed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  repo       TEXT NOT NULL REFERENCES repos(name) ON DELETE CASCADE,
  path       TEXT NOT NULL,
  hash       TEXT NOT NULL,
  indexed_at INTEGER NOT NULL,
  PRIMARY KEY (repo, path)
);
CREATE TABLE IF NOT EXISTS symbols (
  id         TEXT PRIMARY KEY,
  repo       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  name       TEXT NOT NULL,
  file       TEXT NOT NULL,
  container  TEXT,
  span_start INTEGER NOT NULL,
  span_end   INTEGER NOT NULL,
  signature  TEXT,
  doc        TEXT,
  FOREIGN KEY (repo, file) REFERENCES files(repo, path) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(repo, file);
CREATE TABLE IF NOT EXISTS edges (
  from_id  TEXT NOT NULL,
  to_id    TEXT NOT NULL DEFAULT '',
  to_name  TEXT NOT NULL,
  kind     TEXT NOT NULL,
  resolved INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id, to_name, kind)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id) WHERE to_id != '';
CREATE TABLE IF NOT EXISTS retrieval_log (
  id           INTEGER PRIMARY KEY,
  ts           INTEGER NOT NULL,
  source       TEXT NOT NULL,             -- review | retrieve | pack
  signature    TEXT NOT NULL,
  strategy     TEXT NOT NULL,             -- json Strategy
  from_cache   INTEGER NOT NULL,
  seeds        TEXT NOT NULL,             -- json string[]
  item_count   INTEGER NOT NULL,
  elided_count INTEGER NOT NULL,
  used_chars   INTEGER NOT NULL,
  latency_ms   INTEGER NOT NULL,
  -- outcome, filled in later (feedback signals, §4-⑤)
  sections_used     TEXT,                 -- json string[] cited by review findings
  grounded_findings INTEGER,
  total_findings    INTEGER,
  feedback          INTEGER               -- +1 / -1 human signal
);
CREATE TABLE IF NOT EXISTS pattern_cache (
  signature  TEXT PRIMARY KEY,
  strategy   TEXT NOT NULL,               -- json Strategy
  source     TEXT NOT NULL,               -- learned | promoted
  score      REAL NOT NULL,               -- recall with this strategy at learn time
  baseline   REAL NOT NULL,               -- recall with the default strategy
  uses       INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS eval_history (
  id           INTEGER PRIMARY KEY,
  ts           INTEGER NOT NULL,
  golden       TEXT NOT NULL,
  cases        INTEGER NOT NULL,
  micro_recall REAL NOT NULL,
  macro_recall REAL NOT NULL,
  perfect      INTEGER NOT NULL,
  budget       INTEGER NOT NULL,
  hops         INTEGER NOT NULL,
  used_cache   INTEGER NOT NULL,
  note         TEXT
);
`;

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    // Pre-v2 dbs (files keyed by path alone) cannot be migrated in place:
    // symbol ids are hashed without the repo dimension, so every id — and
    // every edge endpoint — would change anyway. Re-indexing is the migration.
    const filesCols = this.db
      .prepare(`SELECT name FROM pragma_table_info('files')`)
      .all() as { name: string }[];
    if (filesCols.length > 0 && !filesCols.some((c) => c.name === 'repo')) {
      this.db.close();
      throw new Error(
        `incompatible index schema (pre-v${SCHEMA_VERSION}, single-repo) at ${path} — ` +
          `delete the db and re-run \`librarian index <repo> --db ${path}\``
      );
    }
    this.db.exec(SCHEMA);
    if (this.getMeta('schema_version') === null) this.setMeta('schema_version', SCHEMA_VERSION);
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

  upsertRepo(name: string, root: string): void {
    this.db
      .prepare(
        `INSERT INTO repos(name, root, indexed_at) VALUES(?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET root = excluded.root, indexed_at = excluded.indexed_at`
      )
      .run(name, root, Date.now());
  }

  getRepo(name: string): RepoRow | null {
    const row = this.db.prepare('SELECT * FROM repos WHERE name = ?').get(name) as
      | { name: string; root: string; indexed_at: number }
      | undefined;
    return row ? { name: row.name, root: row.root, indexedAt: row.indexed_at } : null;
  }

  listRepos(): RepoRow[] {
    return (
      this.db.prepare('SELECT * FROM repos ORDER BY name').all() as {
        name: string;
        root: string;
        indexed_at: number;
      }[]
    ).map((r) => ({ name: r.name, root: r.root, indexedAt: r.indexed_at }));
  }

  fileHash(repo: string, path: string): string | null {
    const row = this.db
      .prepare('SELECT hash FROM files WHERE repo = ? AND path = ?')
      .get(repo, path) as { hash: string } | undefined;
    return row?.hash ?? null;
  }

  /** Replace a file's rows wholesale: its symbols, and edges originating from them. */
  replaceFile(repo: string, path: string, hash: string, symbols: Omit<SymbolRow, 'repo'>[], edges: EdgeRow[]): void {
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(`DELETE FROM edges WHERE from_id IN (SELECT id FROM symbols WHERE repo = ? AND file = ?)`)
        .run(repo, path);
      this.db.prepare('DELETE FROM symbols WHERE repo = ? AND file = ?').run(repo, path);
      this.db
        .prepare(
          'INSERT INTO files(repo, path, hash, indexed_at) VALUES(?, ?, ?, ?) ON CONFLICT(repo, path) DO UPDATE SET hash = excluded.hash, indexed_at = excluded.indexed_at'
        )
        .run(repo, path, hash, Date.now());
      const insSym = this.db.prepare(
        'INSERT OR REPLACE INTO symbols(id, repo, kind, name, file, container, span_start, span_end, signature, doc) VALUES(?,?,?,?,?,?,?,?,?,?)'
      );
      for (const s of symbols) {
        insSym.run(s.id, repo, s.kind, s.name, s.file, s.container, s.spanStart, s.spanEnd, s.signature, s.doc);
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

  removeFiles(repo: string, paths: string[]): void {
    const delEdges = this.db.prepare(
      'DELETE FROM edges WHERE from_id IN (SELECT id FROM symbols WHERE repo = ? AND file = ?)'
    );
    const delFile = this.db.prepare('DELETE FROM files WHERE repo = ? AND path = ?');
    for (const p of paths) {
      delEdges.run(repo, p);
      delFile.run(repo, p);
    }
  }

  listFiles(repo?: string): { repo: string; path: string; hash: string }[] {
    if (repo !== undefined) {
      return this.db
        .prepare('SELECT repo, path, hash FROM files WHERE repo = ? ORDER BY path')
        .all(repo) as { repo: string; path: string; hash: string }[];
    }
    return this.db.prepare('SELECT repo, path, hash FROM files ORDER BY repo, path').all() as {
      repo: string;
      path: string;
      hash: string;
    }[];
  }

  stats(): {
    files: number;
    symbols: number;
    edges: number;
    unresolvedEdges: number;
    byKind: Record<string, number>;
    byExtension: Record<string, number>;
    byRepo: Record<string, { files: number; symbols: number }>;
  } {
    const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    const byKind: Record<string, number> = {};
    for (const row of this.db
      .prepare('SELECT kind, COUNT(*) AS n FROM symbols GROUP BY kind ORDER BY n DESC')
      .all() as { kind: string; n: number }[]) {
      byKind[row.kind] = row.n;
    }
    const byRepo: Record<string, { files: number; symbols: number }> = {};
    for (const row of this.db
      .prepare(
        `SELECT f.repo AS repo, COUNT(*) AS files,
                (SELECT COUNT(*) FROM symbols s WHERE s.repo = f.repo) AS symbols
         FROM files f GROUP BY f.repo ORDER BY f.repo`
      )
      .all() as { repo: string; files: number; symbols: number }[]) {
      byRepo[row.repo] = { files: row.files, symbols: row.symbols };
    }
    // language breakdown (#10): which extractor family each indexed file
    // belongs to is visible from its extension
    const byExtension: Record<string, number> = {};
    for (const f of this.listFiles()) {
      const base = f.path.slice(f.path.lastIndexOf('/') + 1);
      const dot = base.lastIndexOf('.');
      const ext = dot <= 0 ? '(none)' : base.slice(dot + 1);
      byExtension[ext] = (byExtension[ext] ?? 0) + 1;
    }
    return {
      files: one('SELECT COUNT(*) AS n FROM files'),
      symbols: one('SELECT COUNT(*) AS n FROM symbols'),
      edges: one('SELECT COUNT(*) AS n FROM edges'),
      unresolvedEdges: one('SELECT COUNT(*) AS n FROM edges WHERE resolved = 0'),
      byKind,
      byExtension,
      byRepo,
    };
  }

  /**
   * Per-repo symbol/edge counts (#29). `stats()` is db-wide, so an index
   * summary that reported `stats()` inflated symbols/edges to the store total
   * once a db held more than one repo. Edges have no repo column — they are
   * scoped through their originating symbol (`from_id`), matching how
   * `replaceFile` deletes them.
   */
  statsForRepo(repo: string): { symbols: number; edges: number; unresolvedEdges: number } {
    const one = (sql: string, ...params: string[]) =>
      (this.db.prepare(sql).get(...params) as { n: number }).n;
    return {
      symbols: one('SELECT COUNT(*) AS n FROM symbols WHERE repo = ?', repo),
      edges: one(
        'SELECT COUNT(*) AS n FROM edges e JOIN symbols s ON e.from_id = s.id WHERE s.repo = ?',
        repo
      ),
      unresolvedEdges: one(
        'SELECT COUNT(*) AS n FROM edges e JOIN symbols s ON e.from_id = s.id WHERE s.repo = ? AND e.resolved = 0',
        repo
      ),
    };
  }

  /** Cross-repo by default (#11); pass `repo` to scope to one repository. */
  findSymbols(query: string, limit = 20, repo?: string): SymbolRow[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM symbols
           WHERE (name = ?1 OR name LIKE ?2 OR (container || '.' || name) = ?1)
             AND (?4 IS NULL OR repo = ?4)
           ORDER BY CASE WHEN name = ?1 THEN 0 ELSE 1 END, repo, file, span_start
           LIMIT ?3`
        )
        .all(query, `%${query}%`, limit, repo ?? null) as unknown[]
    ).map(rowToSymbol);
  }

  symbolsInFile(file: string, repo?: string): SymbolRow[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM symbols WHERE file = ?1 AND (?2 IS NULL OR repo = ?2) ORDER BY repo, span_start'
        )
        .all(file, repo ?? null) as unknown[]
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

  /**
   * Per-file symbol counts (#28). The web "書架を歩く" view builds its
   * repo → directory → file → symbol hierarchy from this without loading every
   * symbol row; drilling into a file's symbols uses `symbolsInFile`.
   */
  symbolCountsByFile(repo?: string): FileCount[] {
    return (
      this.db
        .prepare(
          `SELECT repo, file, COUNT(*) AS symbols
           FROM symbols
           WHERE (?1 IS NULL OR repo = ?1)
           GROUP BY repo, file
           ORDER BY repo, file`
        )
        .all(repo ?? null) as { repo: string; file: string; symbols: number }[]
    ).map((r) => ({ repo: r.repo, file: r.file, symbols: r.symbols }));
  }

  /**
   * The code graph collapsed to file granularity (#28). Every symbol→symbol
   * edge is rolled up into a per-(from-file, to-file, kind, resolved) bundle
   * with a count, so a dense neighborhood that would render as an unreadable
   * hairball ("真っ黒") becomes at most one line per file pair and edge kind.
   * Unresolved edges keep their kind but have no target file (toRepo/toFile
   * null); the display layer folds these into per-file badges or repo-level
   * rollups. Aggregation only — no display policy here (ADR-5). Cross-repo
   * resolved edges (#27) are preserved: `?1` scopes the *from* side, the
   * target repo may differ.
   */
  collapsedEdges(repo?: string): CollapsedEdge[] {
    return (
      this.db
        .prepare(
          `SELECT sf.repo AS from_repo, sf.file AS from_file,
                  st.repo AS to_repo, st.file AS to_file,
                  e.kind AS kind, e.resolved AS resolved, COUNT(*) AS n
           FROM edges e
           JOIN symbols sf ON sf.id = e.from_id
           LEFT JOIN symbols st ON (e.resolved = 1 AND e.to_id != '' AND st.id = e.to_id)
           WHERE (?1 IS NULL OR sf.repo = ?1)
           GROUP BY from_repo, from_file, to_repo, to_file, e.kind, e.resolved
           ORDER BY from_repo, from_file, to_repo, to_file, e.kind`
        )
        .all(repo ?? null) as {
        from_repo: string;
        from_file: string;
        to_repo: string | null;
        to_file: string | null;
        kind: EdgeKind;
        resolved: number;
        n: number;
      }[]
    ).map((r) => ({
      fromRepo: r.from_repo,
      fromFile: r.from_file,
      toRepo: r.to_repo,
      toFile: r.to_file,
      kind: r.kind,
      resolved: r.resolved === 1,
      count: r.n,
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

  /**
   * Edges a file owns = edges whose from-symbol lives in it (the same rule
   * replaceFile deletes by), in a deterministic order for `export --scip`.
   */
  edgesFromFile(repo: string, file: string): EdgeRow[] {
    const rows = this.db
      .prepare(
        `SELECT e.* FROM edges e JOIN symbols s ON s.id = e.from_id
         WHERE s.repo = ? AND s.file = ?
         ORDER BY s.span_start, e.from_id, e.kind, e.to_name, e.to_id`
      )
      .all(repo, file) as Record<string, unknown>[];
    return rows.map((r) => ({
      fromId: r.from_id as string,
      toId: (r.to_id as string) === '' ? null : (r.to_id as string),
      toName: r.to_name as string,
      kind: r.kind as EdgeKind,
      resolved: (r.resolved as number) === 1,
    }));
  }

  // ---- Phase 4: self-improving retrieval loop (§4-⑤) ----

  logRetrieval(entry: {
    source: string;
    signature: string;
    strategy: string;
    fromCache: boolean;
    seeds: string[];
    itemCount: number;
    elidedCount: number;
    usedChars: number;
    latencyMs: number;
  }): number {
    const res = this.db
      .prepare(
        `INSERT INTO retrieval_log(ts, source, signature, strategy, from_cache, seeds, item_count, elided_count, used_chars, latency_ms)
         VALUES(?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        Date.now(),
        entry.source,
        entry.signature,
        entry.strategy,
        entry.fromCache ? 1 : 0,
        JSON.stringify(entry.seeds),
        entry.itemCount,
        entry.elidedCount,
        entry.usedChars,
        entry.latencyMs
      );
    return Number(res.lastInsertRowid);
  }

  updateRetrievalOutcome(
    id: number,
    outcome: { sectionsUsed?: string[]; groundedFindings?: number; totalFindings?: number; feedback?: number }
  ): boolean {
    const res = this.db
      .prepare(
        `UPDATE retrieval_log SET
           sections_used     = COALESCE(?, sections_used),
           grounded_findings = COALESCE(?, grounded_findings),
           total_findings    = COALESCE(?, total_findings),
           feedback          = COALESCE(?, feedback)
         WHERE id = ?`
      )
      .run(
        outcome.sectionsUsed ? JSON.stringify(outcome.sectionsUsed) : null,
        outcome.groundedFindings ?? null,
        outcome.totalFindings ?? null,
        outcome.feedback ?? null,
        id
      );
    return res.changes > 0;
  }

  listRetrievals(limit = 20): Record<string, unknown>[] {
    return this.db
      .prepare('SELECT * FROM retrieval_log ORDER BY id DESC LIMIT ?')
      .all(limit) as Record<string, unknown>[];
  }

  getPattern(signature: string): { strategy: string; source: string; score: number; baseline: number } | null {
    const row = this.db
      .prepare('SELECT strategy, source, score, baseline FROM pattern_cache WHERE signature = ?')
      .get(signature) as { strategy: string; source: string; score: number; baseline: number } | undefined;
    if (row) {
      this.db.prepare('UPDATE pattern_cache SET uses = uses + 1 WHERE signature = ?').run(signature);
    }
    return row ?? null;
  }

  putPattern(signature: string, strategy: string, source: string, score: number, baseline: number): void {
    this.db
      .prepare(
        `INSERT INTO pattern_cache(signature, strategy, source, score, baseline, uses, updated_at)
         VALUES(?,?,?,?,?,0,?)
         ON CONFLICT(signature) DO UPDATE SET
           strategy = excluded.strategy, source = excluded.source,
           score = excluded.score, baseline = excluded.baseline, updated_at = excluded.updated_at`
      )
      .run(signature, strategy, source, score, baseline, Date.now());
  }

  listPatterns(): Record<string, unknown>[] {
    return this.db
      .prepare('SELECT * FROM pattern_cache ORDER BY signature')
      .all() as Record<string, unknown>[];
  }

  recordEval(entry: {
    golden: string;
    cases: number;
    microRecall: number;
    macroRecall: number;
    perfect: number;
    budget: number;
    hops: number;
    usedCache: boolean;
    note?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO eval_history(ts, golden, cases, micro_recall, macro_recall, perfect, budget, hops, used_cache, note)
         VALUES(?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        Date.now(),
        entry.golden,
        entry.cases,
        entry.microRecall,
        entry.macroRecall,
        entry.perfect,
        entry.budget,
        entry.hops,
        entry.usedCache ? 1 : 0,
        entry.note ?? null
      );
  }

  evalHistory(): Record<string, unknown>[] {
    return this.db
      .prepare('SELECT * FROM eval_history ORDER BY id')
      .all() as Record<string, unknown>[];
  }

  /**
   * Resolved edges joined to both endpoint symbols, in a stable (BINARY
   * collation) order — the raw material of `librarian map`. Sorting lives in
   * SQL so every consumer sees the same deterministic sequence.
   */
  resolvedEdgesJoined(): JoinedEdge[] {
    return this.db
      .prepare(
        `SELECT e.kind AS kind,
                f.repo AS from_repo, f.file AS from_file, f.name AS from_name, f.container AS from_container, f.kind AS from_kind,
                t.repo AS to_repo,   t.file AS to_file,   t.name AS to_name,   t.container AS to_container,   t.kind AS to_kind
         FROM edges e
         JOIN symbols f ON f.id = e.from_id
         JOIN symbols t ON t.id = e.to_id
         WHERE e.resolved = 1
         ORDER BY f.repo, f.file, f.container, f.name, t.repo, t.file, t.container, t.name, e.kind`
      )
      .all()
      .map((r) => {
        const row = r as Record<string, unknown>;
        return {
          kind: row.kind as EdgeKind,
          from: {
            repo: row.from_repo as string,
            file: row.from_file as string,
            name: row.from_name as string,
            container: (row.from_container as string | null) ?? null,
            kind: row.from_kind as SymbolKind,
          },
          to: {
            repo: row.to_repo as string,
            file: row.to_file as string,
            name: row.to_name as string,
            container: (row.to_container as string | null) ?? null,
            kind: row.to_kind as SymbolKind,
          },
        };
      });
  }

  /** Unresolved edges aggregated by callee name — the map's "unknown outside world". */
  unresolvedSummary(): { name: string; kind: EdgeKind; count: number }[] {
    return this.db
      .prepare(
        `SELECT to_name AS name, kind, COUNT(*) AS count
         FROM edges WHERE resolved = 0
         GROUP BY to_name, kind
         ORDER BY count DESC, to_name, kind`
      )
      .all() as { name: string; kind: EdgeKind; count: number }[];
  }

  symbolById(id: string): SymbolRow | null {
    const row = this.db.prepare('SELECT * FROM symbols WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToSymbol(row) : null;
  }

  /**
   * Every unresolved edge with the repo/file its from-symbol lives in — the
   * input `librarian link` (#27) resolves against a declared package → repo
   * mapping. Ordered so a link run is deterministic.
   */
  unresolvedEdges(repo?: string): UnresolvedEdge[] {
    return (
      this.db
        .prepare(
          `SELECT e.from_id, e.to_name, e.kind, s.repo, s.file
           FROM edges e JOIN symbols s ON s.id = e.from_id
           WHERE e.resolved = 0 AND (?1 IS NULL OR s.repo = ?1)
           ORDER BY s.repo, s.file, e.from_id, e.kind, e.to_name`
        )
        .all(repo ?? null) as Record<string, unknown>[]
    ).map((r) => ({
      fromId: r.from_id as string,
      fromRepo: r.repo as string,
      fromFile: r.file as string,
      toName: r.to_name as string,
      kind: r.kind as EdgeKind,
    }));
  }

  /**
   * Module-scope declarations of a repo, by name — the only symbols a
   * cross-repo import can name (#27: a method needs type resolution to bind,
   * a module symbol is a file and not importable by name). Returns every
   * match: an ambiguous name is the caller's to refuse, not the store's.
   */
  topLevelSymbolsNamed(repo: string, name: string): SymbolRow[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM symbols
           WHERE repo = ? AND name = ? AND container IS NULL AND kind NOT IN ('module', 'testblock')
           ORDER BY file, span_start`
        )
        .all(repo, name) as unknown[]
    ).map(rowToSymbol);
  }

  /**
   * Candidate targets for a CakePHP-style dispatch (#43): the `<action>` method
   * declared directly on class `<controllerClass>` in `repo`. The convention
   * (`['controller'=>'Foo','action'=>'bar']` → `FooController::bar`) is applied
   * by the caller (`resolve-dispatches`); the store only answers "which methods
   * literally match this class + name". Testblocks are excluded — an action is a
   * plain method. Every match is returned: an ambiguous name (two classes with
   * the same short name across files) is the caller's to refuse, not the store's.
   */
  dispatchTargets(repo: string, controllerClass: string, action: string): SymbolRow[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM symbols
           WHERE repo = ? AND container = ? AND name = ? AND kind = 'method'
           ORDER BY file, span_start`
        )
        .all(repo, controllerClass, action) as unknown[]
    ).map(rowToSymbol);
  }

  moduleSymbol(repo: string, file: string): SymbolRow | null {
    const row = this.db
      .prepare("SELECT * FROM symbols WHERE repo = ? AND file = ? AND kind = 'module'")
      .get(repo, file) as Record<string, unknown> | undefined;
    return row ? rowToSymbol(row) : null;
  }

  /**
   * Point unresolved edges at a target symbol, keeping the raw name in
   * `to_name` (to_id is part of the PK, so this is a delete + insert). The raw
   * name is what makes the operation reversible — `unlinkCrossRepo` restores
   * exactly the row the extractor emitted.
   */
  linkEdges(links: { fromId: string; toName: string; kind: EdgeKind; toId: string }[]): number {
    const del = this.db.prepare(
      "DELETE FROM edges WHERE from_id = ? AND to_id = '' AND to_name = ? AND kind = ?"
    );
    const ins = this.db.prepare(
      'INSERT OR REPLACE INTO edges(from_id, to_id, to_name, kind, resolved) VALUES(?,?,?,?,1)'
    );
    let n = 0;
    this.db.exec('BEGIN');
    try {
      for (const l of links) {
        if (del.run(l.fromId, l.toName, l.kind).changes === 0) continue;
        ins.run(l.fromId, l.toId, l.toName, l.kind);
        n++;
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return n;
  }

  /** Resolved edges whose endpoints live in different repos — only `link` creates these. */
  crossRepoEdges(): JoinedEdge[] {
    return this.resolvedEdgesJoined().filter((e) => e.from.repo !== e.to.repo);
  }

  countCrossRepoEdges(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM edges e
         JOIN symbols f ON f.id = e.from_id JOIN symbols t ON t.id = e.to_id
         WHERE e.resolved = 1 AND f.repo != t.repo`
      )
      .get() as { n: number };
    return row.n;
  }

  /** Resolved `dispatches` edges in the store (0 until `resolve-dispatches` runs, #43). */
  countResolvedDispatches(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM edges WHERE kind = 'dispatches' AND resolved = 1")
      .get() as { n: number };
    return row.n;
  }

  /**
   * Revert every resolved `dispatches` edge to the unresolved row the extractor
   * emitted (`resolve-dispatches --clear`, #43). The raw `to_name` was preserved
   * on resolution (via `linkEdges`), so this restores exactly the extracted row —
   * the same reversibility contract `unlinkCrossRepo` gives cross-repo links.
   */
  unlinkDispatches(): number {
    const rows = this.db
      .prepare("SELECT from_id, to_id, to_name, kind FROM edges WHERE kind = 'dispatches' AND resolved = 1")
      .all() as Record<string, unknown>[];
    const del = this.db.prepare(
      'DELETE FROM edges WHERE from_id = ? AND to_id = ? AND to_name = ? AND kind = ?'
    );
    const ins = this.db.prepare(
      "INSERT OR REPLACE INTO edges(from_id, to_id, to_name, kind, resolved) VALUES(?,'',?,?,0)"
    );
    this.db.exec('BEGIN');
    try {
      for (const r of rows) {
        del.run(r.from_id as string, r.to_id as string, r.to_name as string, r.kind as string);
        ins.run(r.from_id as string, r.to_name as string, r.kind as string);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return rows.length;
  }

  /** Revert every cross-repo edge to the unresolved row it was extracted as (`link --clear`). */
  unlinkCrossRepo(): number {
    const rows = this.db
      .prepare(
        `SELECT e.from_id, e.to_id, e.to_name, e.kind FROM edges e
         JOIN symbols f ON f.id = e.from_id JOIN symbols t ON t.id = e.to_id
         WHERE e.resolved = 1 AND f.repo != t.repo`
      )
      .all() as Record<string, unknown>[];
    const del = this.db.prepare(
      'DELETE FROM edges WHERE from_id = ? AND to_id = ? AND to_name = ? AND kind = ?'
    );
    const ins = this.db.prepare(
      "INSERT OR REPLACE INTO edges(from_id, to_id, to_name, kind, resolved) VALUES(?,'',?,?,0)"
    );
    this.db.exec('BEGIN');
    try {
      for (const r of rows) {
        del.run(r.from_id as string, r.to_id as string, r.to_name as string, r.kind as string);
        ins.run(r.from_id as string, r.to_name as string, r.kind as string);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return rows.length;
  }
}

function rowToSymbol(r: unknown): SymbolRow {
  const row = r as Record<string, unknown>;
  return {
    id: row.id as string,
    repo: row.repo as string,
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
