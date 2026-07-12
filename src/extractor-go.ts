/**
 * GoExtractor — the Go leg of the Extractor seam (issue #7, ADR-2 multi-
 * language path).
 *
 * Extraction itself happens in `go-extractor/` (a small Go binary built on
 * golang.org/x/tools/go/packages, i.e. the official type checker) because
 * re-parsing Go from TS would be syntax-only guessing. This class is just
 * the child-process plumbing: it feeds `{root, files}` JSON on stdin and
 * ingests the SCIP+ envelope the binary prints on stdout (issue #16,
 * docs/scip-design.md §4 — base SCIP in proto3 JSON + ext sidecar; the
 * mapping back to rows lives in src/scip-ingest.ts). The store never
 * learns which language produced the rows.
 *
 * Binary resolution order (build/distribution notes in README):
 *   1. $LIBRARIAN_GO_EXTRACTOR — explicit path to a prebuilt binary
 *   2. `librarian-go-extractor` on $PATH (go install ./go-extractor)
 *   3. `go run <repo>/go-extractor` — dev fallback when a Go toolchain exists
 *
 * When none of these is available the claimed files degrade to file-level
 * module symbols (with a stderr warning) instead of failing the whole index —
 * the same "degrade, don't block" policy the rest of the pipeline follows.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtractionResult, Extractor } from './extractor.js';
import { parseScipPlus } from './scip.js';
import { scipPlusToExtractionResults } from './scip-ingest.js';

const MAX_OUTPUT = 512 * 1024 * 1024;

/** repo checkout location of the extractor's Go source, for the `go run` fallback */
function goExtractorSourceDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'go-extractor');
}

function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

export interface GoCommand {
  cmd: string;
  args: string[];
  cwd?: string;
}

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

/** file-level fallback rows for when no Go toolchain/binary is available */
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

/** must match the binary's id scheme: sha256(file::container::name::kind)[:20] */
function moduleId(file: string): string {
  return createHash('sha256').update(`${file}::::${file}::module`).digest('hex').slice(0, 20);
}

export class GoExtractor implements Extractor {
  readonly extensions = ['.go'];

  extract(rootDir: string, files: string[]): ExtractionResult[] {
    const command = resolveGoExtractorCommand();
    if (!command) {
      console.error(
        'warn: no Go extractor available (set LIBRARIAN_GO_EXTRACTOR, `go install ./go-extractor`, ' +
          'or install a Go toolchain) — .go files indexed at file level only. ' +
          'Reindex after installing (touch the files or delete the db) to get symbols/edges.'
      );
      return fileLevelOnly(rootDir, files);
    }
    const res = spawnSync(command.cmd, command.args, {
      cwd: command.cwd,
      input: JSON.stringify({ root: rootDir, files }),
      encoding: 'utf8',
      maxBuffer: MAX_OUTPUT,
    });
    if (res.error) {
      throw new Error(`go extractor failed to spawn (${command.cmd}): ${res.error.message}`);
    }
    if (res.stderr) process.stderr.write(res.stderr);
    if (res.status !== 0) {
      throw new Error(`go extractor exited with ${res.status}`);
    }
    const payload: unknown = JSON.parse(res.stdout);
    if (Array.isArray(payload)) {
      throw new Error(
        'go extractor emitted the legacy ExtractionResult[] contract — the contract is now the ' +
          'SCIP+ envelope (issue #16). Rebuild the binary: `go install ./go-extractor` or update ' +
          'LIBRARIAN_GO_EXTRACTOR to a current build.'
      );
    }
    const { index, ext } = parseScipPlus(payload);
    return scipPlusToExtractionResults(index, ext);
  }
}
