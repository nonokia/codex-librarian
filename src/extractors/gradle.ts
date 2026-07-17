/**
 * GradleExtractor — the Gradle build-graph leg of the Extractor seam
 * (issue #38, ADR-2 multi-language path), a reference plugin of the
 * subprocess protocol (issue #22 / ADR-7).
 *
 * Extraction happens in `gradle-extractor/` (a small Go binary). It is a
 * deliberate SYNTAX-LEVEL scanner, not the Gradle Tooling API: the Tooling
 * API evaluates the build (plugin resolution, downloads, script execution) —
 * non-deterministic, which the determinism invariant cannot absorb (the
 * ADR-2 tension issue #38 asked to judge; recorded in dlog). The declarative
 * subset that matters (include, project(":x"), tasks/dependsOn, plugin ids,
 * catalog accessors, Maven coordinates) is string-literal-level in both
 * DSLs; dynamic declarations stay resolved=0. `gradle/libs.versions.toml`
 * is parsed exactly (TOML).
 *
 * Routing: `*.gradle` / `*.gradle.kts` plus exactly `gradle/libs.versions.toml`
 * — a `claims` predicate (the #40 mechanism), because claiming all `.toml`
 * would swallow Cargo.toml / pyproject.toml.
 *
 * Binary resolution order (build/distribution notes in README):
 *   1. $LIBRARIAN_GRADLE_EXTRACTOR — explicit path to a prebuilt binary
 *   2. `librarian-gradle-extractor` on $PATH (go install ./gradle-extractor)
 *   3. `go run <repo>/gradle-extractor` — dev fallback when Go exists
 */
import { existsSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isGradleSchemePath } from '../protocol/scip-export.js';
import { SubprocessExtractor, type SubprocessCommand } from './subprocess.js';

function gradleExtractorSourceDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'gradle-extractor');
}

function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

export function resolveGradleExtractorCommand(): SubprocessCommand | null {
  const explicit = process.env.LIBRARIAN_GRADLE_EXTRACTOR;
  if (explicit) return { cmd: explicit, args: [] };
  const installed = onPath('librarian-gradle-extractor');
  if (installed) return { cmd: installed, args: [] };
  const src = gradleExtractorSourceDir();
  if (onPath('go') && existsSync(join(src, 'main.go'))) {
    return { cmd: 'go', args: ['run', '.'], cwd: src };
  }
  return null;
}

const UNAVAILABLE_WARNING =
  'warn: no Gradle extractor available (set LIBRARIAN_GRADLE_EXTRACTOR, `go install ./gradle-extractor`, ' +
  'or install a Go toolchain) — Gradle build files indexed at file level only. ' +
  'Reindex after installing (touch the files or delete the db) to get symbols/edges.';

export class GradleExtractor extends SubprocessExtractor {
  constructor() {
    super({
      name: 'librarian-gradle',
      extensions: ['.gradle', '.gradle.kts'],
      resolveCommand: resolveGradleExtractorCommand,
      unavailableWarning: UNAVAILABLE_WARNING,
    });
  }

  claims(relPath: string): boolean {
    return isGradleSchemePath(relPath);
  }
}
