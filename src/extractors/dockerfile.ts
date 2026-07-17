/**
 * DockerfileExtractor — the Dockerfile leg of the Extractor seam (issue #40,
 * ADR-2 multi-language path), a reference plugin of the subprocess protocol
 * (issue #22 / ADR-7), like the Terraform and SQL legs.
 *
 * Extraction happens in `dockerfile-extractor/` (a small Go binary built on
 * BuildKit's own Dockerfile frontend — the official implementation). The graph
 * is a build-stage/ARG *reference* graph: FROM/COPY --from/RUN --mount=from
 * resolve to prior stages in-file; external base images become unresolved
 * `imports` edges carrying the tag-stripped image specifier (the future
 * links.json image→repo entry point, #35); COPY/ADD literal sources that exist
 * stay unresolved `references` with the repo-relative path (binding across
 * extractors is a future post-pass — see dlog).
 *
 * Routing (issue #40): `Dockerfile` has no extension, so this leg is the first
 * user of the optional `claims` predicate — it claims basename `Dockerfile`,
 * `Dockerfile.*`, and the `.dockerfile` suffix. ADR-7's explicit-registration
 * trust model is unchanged.
 *
 * Binary resolution order (build/distribution notes in README):
 *   1. $LIBRARIAN_DOCKERFILE_EXTRACTOR — explicit path to a prebuilt binary
 *   2. `librarian-dockerfile-extractor` on $PATH (go install ./dockerfile-extractor)
 *   3. `go run <repo>/dockerfile-extractor` — dev fallback when Go exists
 */
import { existsSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDockerfilePath } from '../protocol/scip-export.js';
import { SubprocessExtractor, type SubprocessCommand } from './subprocess.js';

function dockerfileExtractorSourceDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dockerfile-extractor');
}

function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

export function resolveDockerfileExtractorCommand(): SubprocessCommand | null {
  const explicit = process.env.LIBRARIAN_DOCKERFILE_EXTRACTOR;
  if (explicit) return { cmd: explicit, args: [] };
  const installed = onPath('librarian-dockerfile-extractor');
  if (installed) return { cmd: installed, args: [] };
  const src = dockerfileExtractorSourceDir();
  if (onPath('go') && existsSync(join(src, 'main.go'))) {
    return { cmd: 'go', args: ['run', '.'], cwd: src };
  }
  return null;
}

const UNAVAILABLE_WARNING =
  'warn: no Dockerfile extractor available (set LIBRARIAN_DOCKERFILE_EXTRACTOR, ' +
  '`go install ./dockerfile-extractor`, or install a Go toolchain) — Dockerfiles indexed at ' +
  'file level only. Reindex after installing (touch the files or delete the db) to get symbols/edges.';

export class DockerfileExtractor extends SubprocessExtractor {
  constructor() {
    super({
      name: 'librarian-dockerfile',
      extensions: ['.dockerfile'],
      resolveCommand: resolveDockerfileExtractorCommand,
      unavailableWarning: UNAVAILABLE_WARNING,
    });
  }

  claims(relPath: string): boolean {
    return isDockerfilePath(relPath);
  }
}
