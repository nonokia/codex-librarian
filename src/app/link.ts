/**
 * Cross-repo import resolution (#27) — the `librarian link` step.
 *
 * Several repos may share one index (#11), but their imports of each other stay
 * `resolved = 0`: nothing in a repo's own tree says that `@acme/core` is the
 * repo indexed next to it. This step supplies that missing fact — and only that
 * fact — from an explicit declaration (`.librarian/links.json`), then re-resolves
 * the edges the extractors left open.
 *
 * The three properties that make it safe to run on a shared index:
 *
 *  - **Declared, never guessed.** A package resolves to a repo because a human
 *    wrote it down (ADR-7's trust model: explicit registration, no discovery by
 *    convention). Without a declaration nothing is linked, and the store is
 *    bit-identical to a store that never heard of this command.
 *  - **Bound, never name-matched.** A use site resolves because the extractor
 *    already recorded which package the name came from: an edge the checker
 *    traced to an import of an unresolvable module is named `<spec>#<imported>`,
 *    not by its bare local name (`externalBinding` in the TS extractor). So this
 *    step never matches a bare name against a package — `seen.add(v)` in a file
 *    that also imports an `add` stays unresolved, as it must. Ambiguity (two
 *    declarations of the name in the target repo) is refused, not tiebroken.
 *  - **Reversible and idempotent.** Linking rewrites an unresolved row into a
 *    resolved one keeping the extractor's raw name, so `--clear` restores it
 *    exactly and a second run resolves nothing new.
 *
 * What stays unresolved by design: methods (binding one needs type resolution,
 * not a name), default/namespace imports, and any package with no declaration.
 * Completeness is not the invariant — no false edges is (architecture §8 risk 2).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { EdgeKind, Store } from '../store/store.js';

export interface PackageLink {
  /** the import specifier dependents write, e.g. "@acme/core" (subpaths match too) */
  package: string;
  /** the repo, as named in this index, that publishes it */
  repo: string;
  /** optional repo-relative entry file: makes `imports "<package>"` resolve to its module symbol */
  entry?: string;
}

export interface LinkMap {
  packages: PackageLink[];
}

export interface LinkReport {
  packages: number;
  /** edges this run turned from unresolved into cross-repo resolved */
  newlyResolved: number;
  /** cross-repo resolved edges in the store afterwards (0 + newlyResolved on a fresh link) */
  crossRepoEdges: number;
  byPackage: Record<string, number>;
  /** the name is declared more than once in the target repo — refused, not guessed */
  ambiguous: { package: string; name: string; candidates: string[] }[];
  /** the target repo declares no such module-scope symbol (or entry file) */
  missingTargets: { package: string; name: string }[];
  dryRun: boolean;
}

export function defaultLinkMapPath(dbPath: string): string {
  return join(dirname(dbPath), 'links.json');
}

export function loadLinkMap(path: string): LinkMap {
  return parseLinkMap(JSON.parse(readFileSync(path, 'utf8')), path);
}

export function parseLinkMap(raw: unknown, at = 'link map'): LinkMap {
  const doc = raw as { packages?: unknown };
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.packages)) {
    throw new Error(`${at}: expected { "packages": [ { "package": "@acme/core", "repo": "acme-core" } ] }`);
  }
  const packages = doc.packages.map((p, i): PackageLink => {
    const e = p as Record<string, unknown>;
    const where = `${at}.packages[${i}]`;
    if (typeof e?.package !== 'string' || e.package === '') throw new Error(`${where}.package must be a non-empty string`);
    if (typeof e.repo !== 'string' || e.repo === '') throw new Error(`${where}.repo must be a non-empty string`);
    if (e.entry !== undefined && typeof e.entry !== 'string') throw new Error(`${where}.entry must be a string`);
    return { package: e.package, repo: e.repo, ...(e.entry ? { entry: e.entry } : {}) };
  });
  const dupe = packages.map((p) => p.package).find((p, i, all) => all.indexOf(p) !== i);
  if (dupe) throw new Error(`${at}: package "${dupe}" is declared twice`);
  return { packages };
}

/**
 * Split `<specifier>#<imported>[ as <local>]` into its parts, or null when the
 * name is a bare specifier. The LAST `#` separates them: a Node subpath import
 * specifier is itself `#`-prefixed (`#internal/db`), so a leading `#` is part
 * of the package, never the separator.
 */
function splitBinding(toName: string): { spec: string; imported: string } | null {
  const hash = toName.lastIndexOf('#');
  if (hash <= 0) return null;
  return { spec: toName.slice(0, hash), imported: toName.slice(hash + 1).split(' as ')[0] };
}

export function link(store: Store, map: LinkMap, opts: { dryRun?: boolean } = {}): LinkReport {
  const repos = new Set(store.listRepos().map((r) => r.name));
  for (const p of map.packages) {
    if (!repos.has(p.repo)) {
      throw new Error(
        `link: "${p.package}" maps to repo "${p.repo}", which this index does not hold ` +
          `(indexed: ${[...repos].join(', ') || 'none'}) — index it first, or fix the declaration`
      );
    }
  }
  // Longest specifier wins, so a subpath ("@acme/core/testing") can be declared
  // as its own package alongside the root one.
  const declared = [...map.packages].sort((a, b) => b.package.length - a.package.length);
  const forSpec = (spec: string): PackageLink | null =>
    declared.find((p) => spec === p.package || spec.startsWith(`${p.package}/`)) ?? null;

  const ambiguous = new Map<string, { package: string; name: string; candidates: string[] }>();
  const missing = new Map<string, { package: string; name: string }>();
  const byPackage: Record<string, number> = {};
  const links: { fromId: string; toName: string; kind: EdgeKind; toId: string }[] = [];

  const target = (pkg: PackageLink, name: string): string | null => {
    const candidates = store.topLevelSymbolsNamed(pkg.repo, name);
    const key = `${pkg.package}#${name}`;
    if (candidates.length === 0) {
      missing.set(key, { package: pkg.package, name });
      return null;
    }
    if (candidates.length > 1) {
      ambiguous.set(key, {
        package: pkg.package,
        name,
        candidates: candidates.map((c) => `${c.file}:${c.spanStart}`),
      });
      return null;
    }
    return candidates[0].id;
  };

  const record = (fromId: string, toName: string, kind: EdgeKind, toId: string, pkg: string) => {
    links.push({ fromId, toName, kind, toId });
    byPackage[pkg] = (byPackage[pkg] ?? 0) + 1;
  };

  // One pass over the open edges. An edge is linkable only if the extractor
  // already named the package the name came from (`<spec>#<imported>` — emitted for
  // the import itself and for every use site of it). A bare name is never matched
  // against a package, which is what keeps a method call that happens to share an
  // export's name (`seen.add(v)` in a file that also imports an `add`) unlinked.
  for (const e of store.unresolvedEdges()) {
    const bound = splitBinding(e.toName);
    if (bound) {
      const pkg = forSpec(bound.spec);
      if (!pkg) continue; // undeclared package: left exactly as extracted
      const toId = target(pkg, bound.imported);
      if (toId) record(e.fromId, e.toName, e.kind, toId, pkg.package);
      continue;
    }
    // The bare module-level `imports "<package>"` edge: repo A's module → the
    // entry module of repo B, when the declaration names one.
    if (e.kind !== 'imports') continue;
    const pkg = forSpec(e.toName);
    if (!pkg?.entry) continue;
    const mod = store.moduleSymbol(pkg.repo, pkg.entry);
    if (!mod) {
      missing.set(`${pkg.package}!entry`, { package: pkg.package, name: pkg.entry });
      continue;
    }
    record(e.fromId, e.toName, 'imports', mod.id, pkg.package);
  }

  const newlyResolved = opts.dryRun ? links.length : store.linkEdges(links);
  const byName = (a: { package: string; name: string }, b: { package: string; name: string }) =>
    a.package.localeCompare(b.package) || a.name.localeCompare(b.name);
  return {
    packages: map.packages.length,
    newlyResolved,
    crossRepoEdges: opts.dryRun ? store.countCrossRepoEdges() + links.length : store.countCrossRepoEdges(),
    byPackage,
    ambiguous: [...ambiguous.values()].sort(byName),
    missingTargets: [...missing.values()].sort(byName),
    dryRun: opts.dryRun ?? false,
  };
}

/** `librarian link --clear`: every cross-repo edge back to the unresolved row it came from. */
export function unlink(store: Store): { unlinked: number; crossRepoEdges: number } {
  const unlinked = store.unlinkCrossRepo();
  return { unlinked, crossRepoEdges: store.countCrossRepoEdges() };
}
