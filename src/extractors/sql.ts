/**
 * SqlExtractor — the SQL leg of the Extractor seam (issue #36, ADR-2
 * multi-language path), a reference plugin of the subprocess protocol
 * (issue #22 / ADR-7), like the Go and Terraform legs.
 *
 * Extraction happens in `sql-extractor/` (a small Go binary built on
 * libpg_query via pganalyze/pg_query_go — the PostgreSQL server's own parser
 * as a library). Like HCL, SQL differs from the call-graph languages:
 * declarations and references are lexically explicit (FROM / JOIN / FOREIGN
 * KEY / EXECUTE FUNCTION), so a syntax-level parse is enough — ADR-2's "type
 * resolution required" is a call-graph judgment that does not apply (recorded
 * in dlog). One dialect (Postgres) per build; the binary announces it in
 * `--capabilities`, and files the parser rejects degrade to file level.
 *
 * This file is only the SQL-specific half: how to *find* the binary. The
 * spawn/ingest/degrade plumbing and the `--capabilities` handshake live once
 * in SubprocessExtractor.
 *
 * Binary resolution order (build/distribution notes in README):
 *   1. $LIBRARIAN_SQL_EXTRACTOR — explicit path to a prebuilt binary
 *   2. `librarian-sql-extractor` on $PATH (go install ./sql-extractor)
 *   3. `go run <repo>/sql-extractor` — dev fallback when a Go toolchain exists
 *
 * When none is available the claimed files degrade to file-level module
 * symbols (with a stderr warning) instead of failing the whole index.
 */
import { existsSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SubprocessExtractor, type SubprocessCommand } from './subprocess.js';

/** repo checkout location of the extractor's Go source, for the `go run` fallback */
function sqlExtractorSourceDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'sql-extractor');
}

function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

export function resolveSqlExtractorCommand(): SubprocessCommand | null {
  const explicit = process.env.LIBRARIAN_SQL_EXTRACTOR;
  if (explicit) return { cmd: explicit, args: [] };
  const installed = onPath('librarian-sql-extractor');
  if (installed) return { cmd: installed, args: [] };
  const src = sqlExtractorSourceDir();
  if (onPath('go') && existsSync(join(src, 'main.go'))) {
    return { cmd: 'go', args: ['run', '.'], cwd: src };
  }
  return null;
}

const UNAVAILABLE_WARNING =
  'warn: no SQL extractor available (set LIBRARIAN_SQL_EXTRACTOR, `go install ./sql-extractor`, ' +
  'or install a Go toolchain) — .sql files indexed at file level only. ' +
  'Reindex after installing (touch the files or delete the db) to get symbols/edges.';

export class SqlExtractor extends SubprocessExtractor {
  constructor() {
    super({
      name: 'librarian-sql',
      extensions: ['.sql'],
      resolveCommand: resolveSqlExtractorCommand,
      unavailableWarning: UNAVAILABLE_WARNING,
    });
  }
}
