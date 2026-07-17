/**
 * Extractor registry (issue #22 / ADR-7) — turns the hardcoded extractor list
 * into a composition of built-in reference plugins and a repo-declared
 * `.librarian/extractors.json`.
 *
 * The set of extractors dispatch uses is three layers (design §4.1):
 *
 *   [ TypeScriptExtractor (in-process, ADR-2) ]   always present, the TS anchor
 *     +  built-in reference plugins (Go, PHP)      the two worked examples
 *     +  .librarian/extractors.json                third-party / overrides
 *
 * Precedence (design §4.3, axis A): an explicit registry entry OVERRIDES a
 * built-in for the same extension — so a repo can point `.go` at its own
 * binary, or add a new language, without touching librarian's code. Routing is
 * `Array.find`, so registry entries come first.
 *
 * Trust model (design §7.2): a plugin is an arbitrary command. Discovery is the
 * committed, reviewable `.librarian/extractors.json` ONLY — no PATH-convention
 * auto-discovery, no auto-download. Loading this file means the repo has
 * declared "index me by running these commands", visible in its git history.
 */
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import type { Extractor } from '../protocol/extractor.js';
import { DockerfileExtractor } from '../extractors/dockerfile.js';
import { GoExtractor } from '../extractors/go.js';
import { K8sExtractor } from '../extractors/k8s.js';
import { PhpExtractor } from '../extractors/php.js';
import { PythonExtractor } from '../extractors/python.js';
import { SqlExtractor } from '../extractors/sql.js';
import { SubprocessExtractor, type SubprocessCommand } from '../extractors/subprocess.js';
import { TerraformExtractor } from '../extractors/terraform.js';
import { TypeScriptExtractor } from '../extractors/ts.js';

/** The always-on built-ins: TS in-process, Go/PHP/Python/Terraform/SQL/Dockerfile/k8s as reference plugins. */
export function builtinExtractors(): Extractor[] {
  return [
    new TypeScriptExtractor(),
    new GoExtractor(),
    new PhpExtractor(),
    new PythonExtractor(),
    new TerraformExtractor(),
    new SqlExtractor(),
    new DockerfileExtractor(),
    new K8sExtractor(),
  ];
}

/** One `.librarian/extractors.json` entry: extension → command declaration. */
export interface RegistryEntry {
  /** moniker scheme / ToolInfo.name the plugin reports, e.g. 'librarian-rust' */
  name: string;
  /** extensions this plugin claims, e.g. ['.rs'] */
  extensions: string[];
  /** executable: a bare name (PATH lookup) or a path (absolute, or relative to repo root) */
  command: string;
  /** extra args before the piped `{root, files}` stdin */
  args: string[];
  /** working directory, relative to repo root; undefined = inherit */
  cwd?: string;
}

function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

/**
 * Resolve a registry entry's command at extract time. Missing commands resolve
 * to null so the file degrades to file-level rows (the pipeline-wide "degrade,
 * don't block" policy), rather than throwing mid-index.
 */
function registryCommandResolver(entry: RegistryEntry, root: string): () => SubprocessCommand | null {
  return () => {
    const cwd = entry.cwd ? resolve(root, entry.cwd) : undefined;
    if (entry.command.includes('/') || isAbsolute(entry.command)) {
      const abs = isAbsolute(entry.command) ? entry.command : resolve(root, entry.command);
      return existsSync(abs) ? { cmd: abs, args: entry.args, cwd } : null;
    }
    const found = onPath(entry.command);
    return found ? { cmd: found, args: entry.args, cwd } : null;
  };
}

export function entryToExtractor(entry: RegistryEntry, root: string): SubprocessExtractor {
  return new SubprocessExtractor({
    name: entry.name,
    extensions: entry.extensions,
    resolveCommand: registryCommandResolver(entry, root),
    unavailableWarning:
      `warn: extractor "${entry.name}" (${entry.command}) declared in .librarian/extractors.json ` +
      `was not found — [${entry.extensions.join(', ')}] files indexed at file level only.`,
  });
}

/** Strictly validate a parsed `.librarian/extractors.json`, or throw precisely. */
export function parseRegistry(raw: unknown): RegistryEntry[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('.librarian/extractors.json must be a JSON object');
  }
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) {
    throw new Error(`.librarian/extractors.json version ${JSON.stringify(r.version)} unsupported (expected 1)`);
  }
  if (!Array.isArray(r.extractors)) {
    throw new Error('.librarian/extractors.json requires an "extractors" array');
  }
  return r.extractors.map(parseEntry);
}

function parseEntry(raw: unknown, i: number): RegistryEntry {
  const at = `.librarian/extractors.json extractors[${i}]`;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${at} must be an object`);
  }
  const e = raw as Record<string, unknown>;
  if (typeof e.name !== 'string' || e.name === '') throw new Error(`${at}.name must be a non-empty string`);
  if (
    !Array.isArray(e.extensions) ||
    e.extensions.length === 0 ||
    e.extensions.some((x) => typeof x !== 'string' || !x.startsWith('.'))
  ) {
    throw new Error(`${at}.extensions must be a non-empty array of dot-prefixed extensions (e.g. ".rs")`);
  }
  if (typeof e.command !== 'string' || e.command === '') throw new Error(`${at}.command must be a non-empty string`);
  if (e.args !== undefined && (!Array.isArray(e.args) || e.args.some((x) => typeof x !== 'string'))) {
    throw new Error(`${at}.args must be an array of strings`);
  }
  if (e.cwd !== undefined && typeof e.cwd !== 'string') throw new Error(`${at}.cwd must be a string`);
  return {
    name: e.name,
    extensions: e.extensions as string[],
    command: e.command,
    args: (e.args as string[] | undefined) ?? [],
    cwd: e.cwd as string | undefined,
  };
}

/** Read `<root>/.librarian/extractors.json` if present (empty list otherwise). */
export function loadRegistry(root: string): RegistryEntry[] {
  const path = join(root, '.librarian', 'extractors.json');
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`.librarian/extractors.json is not valid JSON: ${(err as Error).message}`);
  }
  return parseRegistry(parsed);
}

/**
 * Compose the extractor set for a repo: built-ins overlaid with
 * `.librarian/extractors.json`. Registry entries win for their extensions
 * (design §4.3, axis A). With no registry file this returns exactly the
 * built-ins, so an unconfigured repo behaves as before.
 */
export function resolveExtractors(root: string): Extractor[] {
  const registry = loadRegistry(root).map((e) => entryToExtractor(e, root));
  if (registry.length === 0) return builtinExtractors();

  const seen = new Set<string>();
  for (const x of registry) {
    for (const ext of x.extensions) {
      if (seen.has(ext)) {
        console.error(
          `warn: .librarian/extractors.json declares ${ext} more than once; the first entry wins.`
        );
      }
      seen.add(ext);
    }
  }
  const overridden = seen;
  const kept = builtinExtractors().filter((b) => !b.extensions.some((e) => overridden.has(e)));
  return [...registry, ...kept];
}
