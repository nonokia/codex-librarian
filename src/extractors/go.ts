/**
 * GoExtractor — the Go leg of the Extractor seam (issue #7, ADR-2 multi-
 * language path), now a reference plugin of the subprocess protocol (issue #22
 * / ADR-7).
 *
 * Extraction itself happens in `go-extractor/` (a small Go binary built on
 * golang.org/x/tools/go/packages, i.e. the official type checker) because
 * re-parsing Go from TS would be syntax-only guessing. This file is only the
 * Go-specific half: how to *find* the binary. The spawn/ingest/degrade plumbing
 * and the `--capabilities` handshake live once in SubprocessExtractor.
 *
 * Binary resolution order (build/distribution notes in README):
 *   1. $LIBRARIAN_GO_EXTRACTOR — explicit path to a prebuilt binary
 *   2. `librarian-go-extractor` on $PATH (go install ./go-extractor)
 *   3. `go run <repo>/go-extractor` — dev fallback when a Go toolchain exists
 *
 * When none of these is available the claimed files degrade to file-level
 * module symbols (with a stderr warning) instead of failing the whole index.
 */
import { existsSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SubprocessExtractor, type SubprocessCommand } from './subprocess.js';

/** repo checkout location of the extractor's Go source, for the `go run` fallback */
function goExtractorSourceDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'go-extractor');
}

function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

/** Retained name for back-compat; a SubprocessCommand for the Go binary. */
export type GoCommand = SubprocessCommand;

export function resolveGoExtractorCommand(): GoCommand | null {
  const explicit = process.env.LIBRARIAN_GO_EXTRACTOR;
  if (explicit) return { cmd: explicit, args: [] };
  const installed = onPath('librarian-go-extractor');
  if (installed) return { cmd: installed, args: [] };
  const src = goExtractorSourceDir();
  if (onPath('go') && existsSync(join(src, 'main.go'))) {
    return { cmd: 'go', args: ['run', '.'], cwd: src };
  }
  return null;
}

const UNAVAILABLE_WARNING =
  'warn: no Go extractor available (set LIBRARIAN_GO_EXTRACTOR, `go install ./go-extractor`, ' +
  'or install a Go toolchain) — .go files indexed at file level only. ' +
  'Reindex after installing (touch the files or delete the db) to get symbols/edges.';

export class GoExtractor extends SubprocessExtractor {
  constructor() {
    super({
      name: 'librarian-go',
      extensions: ['.go'],
      resolveCommand: resolveGoExtractorCommand,
      unavailableWarning: UNAVAILABLE_WARNING,
    });
  }
}
