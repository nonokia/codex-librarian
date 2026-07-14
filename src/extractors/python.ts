/**
 * PythonExtractor — the Python leg of the Extractor seam (issue #6, ADR-2
 * multi-language path), a reference plugin of the subprocess protocol (issue
 * #22 / ADR-7), like the Go, PHP and Terraform legs.
 *
 * Extraction happens in `py-extractor/extract.py` (a Python script on the
 * standard library's `ast` — CPython's own parser, so the grammar is never a
 * re-implementation). Python ships no stdlib type checker, so the script builds
 * the name story itself: import graph, per-module bindings, class MRO with
 * override edges, and a small type environment (annotated params, `self`,
 * constructed locals, attribute types learned in `__init__`). Anything it
 * cannot type stays resolved=false with the name as written — the same
 * measurability-over-completeness policy as the other legs. Rejected
 * alternatives are recorded in dlog and docs/python-baseline.md.
 *
 * This file is only the Python-specific half: how to *find* the interpreter +
 * script. The spawn/ingest/degrade plumbing and the `--capabilities` handshake
 * live once in SubprocessExtractor.
 *
 * The script is interpreted (no build step) and depends on nothing outside the
 * standard library, so the only requirement is a `python3` interpreter.
 * Command resolution:
 *   1. $LIBRARIAN_PY_EXTRACTOR — explicit path to an extract.py
 *   2. `python3 <repo>/py-extractor/extract.py` — the shipped script
 * ($PYTHON_BINARY overrides the interpreter; parse fidelity is bounded by its
 * grammar version — a file whose syntax is newer degrades to file level).
 * When neither the script nor an interpreter is available, the claimed files
 * degrade to file-level module symbols (with a stderr warning) instead of
 * failing the whole index.
 *
 * An external scip-python index remains importable via `librarian import`
 * (issue #16 degrade path, docs/scip-baseline.md) — this extractor is the
 * native alternative, not a replacement for that route.
 */
import { existsSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SubprocessExtractor, type SubprocessCommand } from './subprocess.js';

/** repo checkout location of the extractor's Python source */
function pyExtractorDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'py-extractor');
}

function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

export function resolvePythonExtractorCommand(): SubprocessCommand | null {
  const python = process.env.PYTHON_BINARY || onPath('python3') || onPath('python');
  if (!python) return null;
  const script = process.env.LIBRARIAN_PY_EXTRACTOR || join(pyExtractorDir(), 'extract.py');
  if (!existsSync(script)) return null;
  return { cmd: python, args: [script] };
}

const UNAVAILABLE_WARNING =
  'warn: no Python extractor available (install a python3 interpreter, or set ' +
  'LIBRARIAN_PY_EXTRACTOR to an extract.py) — .py files indexed at file level only. ' +
  'Reindex after installing (touch the files or delete the db) to get symbols/edges.';

export class PythonExtractor extends SubprocessExtractor {
  constructor() {
    super({
      name: 'librarian-py',
      extensions: ['.py', '.pyi'],
      resolveCommand: resolvePythonExtractorCommand,
      unavailableWarning: UNAVAILABLE_WARNING,
    });
  }
}
