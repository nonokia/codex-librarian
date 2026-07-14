/**
 * TerraformExtractor — the Terraform (HCL) leg of the Extractor seam (issue #9,
 * ADR-2 multi-language path), a reference plugin of the subprocess protocol
 * (issue #22 / ADR-7), like the Go and PHP legs.
 *
 * Extraction happens in `tf-extractor/` (a small Go binary built on
 * hashicorp/hcl). HCL differs from the call-graph languages: references are
 * lexically explicit (`var.x` / `module.y.out` / `aws_x.y.attr`), so a
 * syntax-level parse is enough — ADR-2's "type resolution required" is a
 * call-graph judgment that does not apply to HCL (recorded in dlog). This file
 * is only the Terraform-specific half: how to *find* the binary. The
 * spawn/ingest/degrade plumbing and the `--capabilities` handshake live once in
 * SubprocessExtractor.
 *
 * Binary resolution order (build/distribution notes in README):
 *   1. $LIBRARIAN_TF_EXTRACTOR — explicit path to a prebuilt binary
 *   2. `librarian-tf-extractor` on $PATH (go install ./tf-extractor)
 *   3. `go run <repo>/tf-extractor` — dev fallback when a Go toolchain exists
 *
 * When none is available the claimed files degrade to file-level module symbols
 * (with a stderr warning) instead of failing the whole index.
 */
import { existsSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SubprocessExtractor, type SubprocessCommand } from './subprocess.js';

/** repo checkout location of the extractor's Go source, for the `go run` fallback */
function tfExtractorSourceDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tf-extractor');
}

function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

export function resolveTerraformExtractorCommand(): SubprocessCommand | null {
  const explicit = process.env.LIBRARIAN_TF_EXTRACTOR;
  if (explicit) return { cmd: explicit, args: [] };
  const installed = onPath('librarian-tf-extractor');
  if (installed) return { cmd: installed, args: [] };
  const src = tfExtractorSourceDir();
  if (onPath('go') && existsSync(join(src, 'main.go'))) {
    return { cmd: 'go', args: ['run', '.'], cwd: src };
  }
  return null;
}

const UNAVAILABLE_WARNING =
  'warn: no Terraform extractor available (set LIBRARIAN_TF_EXTRACTOR, `go install ./tf-extractor`, ' +
  'or install a Go toolchain) — .tf files indexed at file level only. ' +
  'Reindex after installing (touch the files or delete the db) to get symbols/edges.';

export class TerraformExtractor extends SubprocessExtractor {
  constructor() {
    super({
      name: 'librarian-terraform',
      extensions: ['.tf'],
      resolveCommand: resolveTerraformExtractorCommand,
      unavailableWarning: UNAVAILABLE_WARNING,
    });
  }
}
