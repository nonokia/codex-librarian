/**
 * PhpExtractor — the PHP leg of the Extractor seam (issue #8, ADR-2 multi-
 * language path).
 *
 * Extraction itself happens in `php-extractor/extract.php` (a PHP script built
 * on nikic/php-parser — the parsing base PHPStan and Psalm share — with its
 * NameResolver for namespace/`use` resolution) because re-parsing PHP from TS
 * would be syntax-only guessing with no name story. This class is just the
 * child-process plumbing: it feeds `{root, files}` JSON on stdin and ingests
 * the SCIP+ envelope the script prints on stdout (issue #16,
 * docs/scip-design.md §4 — hand-built proto3 JSON, no protobuf dependency in
 * PHP; the mapping back to rows lives in src/scip-ingest.ts). The store never
 * learns which language produced the rows.
 *
 * The script is interpreted (no build step) and its parser is vendored beside
 * it, so the only requirement is a `php` interpreter. Command resolution:
 *   1. $LIBRARIAN_PHP_EXTRACTOR — explicit path to an extract.php
 *   2. `php <repo>/php-extractor/extract.php` — the vendored script
 * (`php` binary overridable via $PHP_BINARY). When neither the script nor a
 * php interpreter is available the claimed files degrade to file-level module
 * symbols (with a stderr warning) instead of failing the whole index — the
 * same "degrade, don't block" policy the rest of the pipeline follows.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtractionResult, Extractor } from '../protocol/extractor.js';
import { parseScipPlus } from '../protocol/scip.js';
import { scipPlusToExtractionResults } from '../protocol/scip-ingest.js';

const MAX_OUTPUT = 512 * 1024 * 1024;

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

export interface PhpCommand {
  cmd: string;
  args: string[];
}

export function resolvePhpExtractorCommand(): PhpCommand | null {
  const php = process.env.PHP_BINARY || onPath('php');
  if (!php) return null;
  const script = process.env.LIBRARIAN_PHP_EXTRACTOR || join(phpExtractorDir(), 'extract.php');
  if (!existsSync(script)) return null;
  // the vendored parser must be present next to the script (self-contained)
  if (!existsSync(join(dirname(script), 'vendor', 'autoload.php'))) return null;
  return { cmd: php, args: [script] };
}

/** file-level fallback rows for when no php interpreter/script is available */
function fileLevelOnly(rootDir: string, files: string[]): ExtractionResult[] {
  return files.map((abs) => {
    const file = relative(rootDir, abs).split(sep).join('/');
    let lines = 1;
    try {
      const text = readFileSync(abs, 'utf8');
      lines = Math.max(1, text.split('\n').length - (text.endsWith('\n') ? 1 : 0));
    } catch {
      /* unreadable file still gets a 1-line module row */
    }
    return {
      file,
      symbols: [
        {
          id: moduleId(file),
          kind: 'module' as const,
          name: file,
          file,
          container: null,
          spanStart: 1,
          spanEnd: lines,
          signature: null,
          doc: null,
        },
      ],
      edges: [],
    };
  });
}

/** must match the script's id scheme: sha256(file::container::name::kind)[:20] */
function moduleId(file: string): string {
  return createHash('sha256').update(`${file}::::${file}::module`).digest('hex').slice(0, 20);
}

export class PhpExtractor implements Extractor {
  readonly extensions = ['.php'];

  extract(rootDir: string, files: string[]): ExtractionResult[] {
    const command = resolvePhpExtractorCommand();
    if (!command) {
      console.error(
        'warn: no PHP extractor available (install a php interpreter, or set ' +
          'LIBRARIAN_PHP_EXTRACTOR to an extract.php with its vendor/) — .php files ' +
          'indexed at file level only. Reindex after installing (touch the files or ' +
          'delete the db) to get symbols/edges.'
      );
      return fileLevelOnly(rootDir, files);
    }
    const res = spawnSync(command.cmd, command.args, {
      input: JSON.stringify({ root: rootDir, files }),
      encoding: 'utf8',
      maxBuffer: MAX_OUTPUT,
    });
    if (res.error) {
      throw new Error(`php extractor failed to spawn (${command.cmd}): ${res.error.message}`);
    }
    if (res.stderr) process.stderr.write(res.stderr);
    if (res.status !== 0) {
      throw new Error(`php extractor exited with ${res.status}`);
    }
    const payload: unknown = JSON.parse(res.stdout);
    if (Array.isArray(payload)) {
      throw new Error(
        'php extractor emitted the legacy ExtractionResult[] contract — the contract is now the ' +
          'SCIP+ envelope (issue #16). Point LIBRARIAN_PHP_EXTRACTOR at a current extract.php.'
      );
    }
    const { index, ext } = parseScipPlus(payload);
    return scipPlusToExtractionResults(index, ext);
  }
}
