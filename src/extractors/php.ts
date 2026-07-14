/**
 * PhpExtractor — the PHP leg of the Extractor seam (issue #8, ADR-2 multi-
 * language path), now a reference plugin of the subprocess protocol (issue #22
 * / ADR-7).
 *
 * Extraction itself happens in `php-extractor/extract.php` (a PHP script built
 * on nikic/php-parser — the parsing base PHPStan and Psalm share — with its
 * NameResolver for namespace/`use` resolution) because re-parsing PHP from TS
 * would be syntax-only guessing with no name story. This file is only the
 * PHP-specific half: how to *find* the interpreter + script. The spawn/ingest/
 * degrade plumbing and the `--capabilities` handshake live once in
 * SubprocessExtractor.
 *
 * The script is interpreted (no build step) and its parser is vendored beside
 * it, so the only requirement is a `php` interpreter. Command resolution:
 *   1. $LIBRARIAN_PHP_EXTRACTOR — explicit path to an extract.php
 *   2. `php <repo>/php-extractor/extract.php` — the vendored script
 * (`php` binary overridable via $PHP_BINARY). When neither the script nor a
 * php interpreter is available the claimed files degrade to file-level module
 * symbols (with a stderr warning) instead of failing the whole index.
 */
import { existsSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SubprocessExtractor, type SubprocessCommand } from './subprocess.js';

/** repo checkout location of the extractor's PHP source + vendored parser */
function phpExtractorDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'php-extractor');
}

function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

/** Retained name for back-compat; a SubprocessCommand for the PHP script. */
export type PhpCommand = SubprocessCommand;

export function resolvePhpExtractorCommand(): PhpCommand | null {
  const php = process.env.PHP_BINARY || onPath('php');
  if (!php) return null;
  const script = process.env.LIBRARIAN_PHP_EXTRACTOR || join(phpExtractorDir(), 'extract.php');
  if (!existsSync(script)) return null;
  // the vendored parser must be present next to the script (self-contained)
  if (!existsSync(join(dirname(script), 'vendor', 'autoload.php'))) return null;
  return { cmd: php, args: [script] };
}

const UNAVAILABLE_WARNING =
  'warn: no PHP extractor available (install a php interpreter, or set ' +
  'LIBRARIAN_PHP_EXTRACTOR to an extract.php with its vendor/) — .php files ' +
  'indexed at file level only. Reindex after installing (touch the files or ' +
  'delete the db) to get symbols/edges.';

export class PhpExtractor extends SubprocessExtractor {
  constructor() {
    super({
      name: 'librarian-php',
      extensions: ['.php'],
      resolveCommand: resolvePhpExtractorCommand,
      unavailableWarning: UNAVAILABLE_WARNING,
    });
  }
}
