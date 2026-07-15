/**
 * Framework-convention dispatch resolution (#43 / ADR-9) — the
 * `librarian resolve-dispatches` step.
 *
 * A framework resolves some call relationships at runtime from strings /
 * configuration / naming conventions, not from the language grammar: CakePHP's
 * `$this->redirect(['controller'=>'Foo','action'=>'bar'])` means "then run
 * `FooController::bar`", but nikic/php-parser sees only an array literal. The
 * php-extractor records that fact as a `dispatches` edge with `resolved=false`
 * and a structured name — `dispatch <controller>#<action>` — and stops there
 * (ADR-9 Step 0). This step supplies the missing convention and binds the edge
 * (Step 1).
 *
 * It is the sibling of `librarian link` (#27 / ADR-8) and shares its discipline,
 * but not its input: `link` resolves CROSS-repo imports from an explicit
 * package → repo declaration; this resolves INTRA-repo dispatch from a naming
 * convention with no declaration file. The three properties that keep it safe:
 *
 *  - **Convention, never guessed.** A dispatch resolves because the CakePHP
 *    convention is unambiguous: `['controller'=>'Foo']` names class
 *    `FooController`, `['action'=>'bar']` its public method `bar`. Nothing is
 *    matched on a bare name; a target that does not exist stays unresolved.
 *  - **Refuse ambiguity.** If two classes share the short name `FooController`
 *    (across files), the edge is refused, not tiebroken — no false edges
 *    (architecture §8 risk 2), same as `link`.
 *  - **Reversible and idempotent.** Binding rewrites the unresolved row into a
 *    resolved one keeping the extractor's raw `dispatch …` name, so `--clear`
 *    restores it exactly and a second run resolves nothing new.
 *
 * What stays unresolved by design: a dispatch whose controller/action is a
 * variable or expression (the extractor never emits it — genuinely dynamic,
 * ADR-9 scope-out), and a convention target this repo does not declare.
 */
import type { EdgeKind, Store, SymbolRow } from '../store/store.js';

/** CakePHP: `['controller'=>'Foo']` addresses class `FooController`. */
const CONTROLLER_SUFFIX = 'Controller';
/** CakePHP: a route with a controller but no action defaults to `index`. */
export const DEFAULT_ACTION = 'index';
/** The extractor's structured name for an unresolved dispatch (#43, ADR-9 §8.2). */
const DISPATCH_PREFIX = 'dispatch ';

export interface DispatchReport {
  /** edges this run turned from unresolved into resolved */
  newlyResolved: number;
  /** resolved `dispatches` edges in the store afterwards */
  resolvedDispatches: number;
  byController: Record<string, number>;
  /** the convention target name is declared more than once — refused, not guessed */
  ambiguous: { controller: string; action: string; candidates: string[] }[];
  /** this repo declares no such `<Controller>::<action>` method */
  missingTargets: { controller: string; action: string }[];
  dryRun: boolean;
}

/**
 * Split the extractor's `dispatch <controller>#<action>` name into its parts, or
 * null when it is not a dispatch binding (leaving it untouched). The controller
 * segment is the raw routing value (a plugin/prefix path like `Admin/Users` is
 * kept whole; the convention below reads its last segment).
 */
export function parseDispatchName(toName: string): { controller: string; action: string } | null {
  if (!toName.startsWith(DISPATCH_PREFIX)) return null;
  const rest = toName.slice(DISPATCH_PREFIX.length);
  const hash = rest.lastIndexOf('#');
  if (hash <= 0) return null;
  const controller = rest.slice(0, hash);
  const action = rest.slice(hash + 1);
  if (controller === '' || action === '') return null;
  return { controller, action };
}

/** `Admin/Users` → `UsersController`; the class short name the convention names. */
function controllerClass(controller: string): string {
  const last = controller.split('/').pop() ?? controller;
  return `${last}${CONTROLLER_SUFFIX}`;
}

export function resolveDispatches(
  store: Store,
  opts: { dryRun?: boolean; repo?: string } = {}
): DispatchReport {
  const ambiguous = new Map<string, { controller: string; action: string; candidates: string[] }>();
  const missing = new Map<string, { controller: string; action: string }>();
  const byController: Record<string, number> = {};
  const links: { fromId: string; toName: string; kind: EdgeKind; toId: string }[] = [];

  for (const e of store.unresolvedEdges(opts.repo)) {
    if (e.kind !== 'dispatches') continue;
    const parsed = parseDispatchName(e.toName);
    if (parsed === null) continue; // not a recognizable dispatch binding: left as-is
    const cls = controllerClass(parsed.controller);
    const key = `${cls}#${parsed.action}`;
    const candidates: SymbolRow[] = store.dispatchTargets(e.fromRepo, cls, parsed.action);
    if (candidates.length === 0) {
      missing.set(key, { controller: cls, action: parsed.action });
      continue;
    }
    if (candidates.length > 1) {
      ambiguous.set(key, {
        controller: cls,
        action: parsed.action,
        candidates: candidates.map((c) => `${c.file}:${c.spanStart}`),
      });
      continue;
    }
    links.push({ fromId: e.fromId, toName: e.toName, kind: e.kind, toId: candidates[0].id });
    byController[cls] = (byController[cls] ?? 0) + 1;
  }

  const newlyResolved = opts.dryRun ? links.length : store.linkEdges(links);
  const byName = (
    a: { controller: string; action: string },
    b: { controller: string; action: string }
  ) => a.controller.localeCompare(b.controller) || a.action.localeCompare(b.action);
  return {
    newlyResolved,
    resolvedDispatches: opts.dryRun
      ? store.countResolvedDispatches() + links.length
      : store.countResolvedDispatches(),
    byController,
    ambiguous: [...ambiguous.values()].sort(byName),
    missingTargets: [...missing.values()].sort(byName),
    dryRun: opts.dryRun ?? false,
  };
}

/** `librarian resolve-dispatches --clear`: every resolved dispatch back to unresolved. */
export function clearDispatches(store: Store): { cleared: number; resolvedDispatches: number } {
  const cleared = store.unlinkDispatches();
  return { cleared, resolvedDispatches: store.countResolvedDispatches() };
}
