/**
 * Indexer — type-resolved symbol/edge extraction (architecture §4-①, ADR-2).
 *
 * Uses the TypeScript Compiler API (not tree-sitter) so call/reference edges
 * come from the type checker, not syntax guesses. `allowJs` + JSX support
 * makes plain-JS React repos indexable too.
 *
 * Resolution policy (architecture §8 risk 2): edges that resolve to a symbol
 * inside the indexed repo are stored resolved; edges to anything else
 * (node_modules, lib.d.ts, truly unknown) are kept with resolved = 0 and the
 * raw callee name — completeness is sacrificed, measurability is not.
 */
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { EdgeKind, EdgeRow, SymbolKind, SymbolRow } from './store.js';
import type { ExtractionResult, Extractor } from './extractor.js';
import { GoExtractor } from './extractor-go.js';
import { PhpExtractor } from './extractor-php.js';
import { Store } from './store.js';

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.dlog', '.librarian', 'out', 'vendor']);
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * The extractor registry (#10). Language support = appending here; the store,
 * retrieval, and UI never learn which extractor produced a row. When two
 * extractors claim the same extension, the first registered wins.
 */
export function defaultExtractors(): Extractor[] {
  return [new TypeScriptExtractor(), new GoExtractor(), new PhpExtractor()];
}

export function discoverSourceFiles(rootDir: string, extensions: string[] = EXTENSIONS): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.name !== '.') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (extensions.some((ext) => entry.name.endsWith(ext)) && !entry.name.endsWith('.d.ts')) {
        found.push(full);
      }
    }
  };
  walk(rootDir);
  return found.sort();
}

/** first registered extractor claiming the file's extension, or null */
function extractorFor(file: string, extractors: Extractor[]): Extractor | null {
  return extractors.find((x) => x.extensions.some((ext) => file.endsWith(ext))) ?? null;
}

export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** Stable symbol id: survives line moves; changes only when identity changes. */
function symbolId(file: string, container: string | null, name: string, kind: string): string {
  return createHash('sha256')
    .update(`${file}::${container ?? ''}::${name}::${kind}`)
    .digest('hex')
    .slice(0, 20);
}

export class TypeScriptExtractor implements Extractor {
  readonly extensions = EXTENSIONS;

  extract(rootDir: string, files: string[]): ExtractionResult[] {
    const program = ts.createProgram(files, {
      allowJs: true,
      checkJs: false,
      jsx: ts.JsxEmit.Preserve,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
      allowImportingTsExtensions: true,
    });
    const checker = program.getTypeChecker();
    const rel = (abs: string) => relative(rootDir, abs).split(sep).join('/');
    const inRepo = new Set(files.map((f) => f));

    // Pass 1: collect declared symbols so pass 2 can resolve edges to them.
    const declToId = new Map<ts.Node, string>();
    const perFile = new Map<string, { symbols: SymbolRow[]; edges: EdgeRow[] }>();

    for (const sf of program.getSourceFiles()) {
      if (!inRepo.has(sf.fileName)) continue;
      const file = rel(sf.fileName);
      const bucket = { symbols: [] as SymbolRow[], edges: [] as EdgeRow[] };
      perFile.set(file, bucket);

      const moduleId = symbolId(file, null, file, 'module');
      bucket.symbols.push({
        id: moduleId,
        kind: 'module',
        name: file,
        file,
        container: null,
        spanStart: 1,
        spanEnd: sf.getLineAndCharacterOfPosition(sf.end).line + 1,
        signature: null,
        doc: null,
      });
      declToId.set(sf, moduleId);

      const usedIds = new Set<string>();
      const visit = (node: ts.Node, container: string | null) => {
        const tb = testBlockCall(node);
        if (tb) {
          let name = tb.name;
          let id = symbolId(file, container, name, 'testblock');
          for (let n = 2; usedIds.has(id); n++) {
            name = `${tb.name}#${n}`;
            id = symbolId(file, container, name, 'testblock');
          }
          usedIds.add(id);
          bucket.symbols.push({
            id,
            kind: 'testblock',
            name,
            file,
            container,
            spanStart: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
            spanEnd: sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
            signature: null,
            doc: null,
          });
          declToId.set(node, id);
          const childContainer = container ? `${container}.${name}` : name;
          node.forEachChild((c) => visit(c, childContainer));
          return;
        }
        const decl = classifyDeclaration(node);
        if (decl) {
          const { name, kind, nameNode } = decl;
          const id = symbolId(file, container, name, kind);
          const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
          const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
          bucket.symbols.push({
            id,
            kind,
            name,
            file,
            container,
            spanStart: start,
            spanEnd: end,
            signature: signatureOf(node, sf),
            doc: docOf(node),
          });
          declToId.set(node, id);
          if (nameNode) declToId.set(nameNode, id);
          const childContainer = container ? `${container}.${name}` : name;
          node.forEachChild((c) => visit(c, childContainer));
          return;
        }
        node.forEachChild((c) => visit(c, container));
      };
      sf.forEachChild((n) => visit(n, null));
    }

    // Pass 2: edges. Walk again, resolving imports / calls / extends / references.
    for (const sf of program.getSourceFiles()) {
      if (!inRepo.has(sf.fileName)) continue;
      const file = rel(sf.fileName);
      const bucket = perFile.get(file)!;
      const moduleId = declToId.get(sf)!;

      const resolveTarget = (node: ts.Node): { id: string | null; name: string } => {
        let sym = checker.getSymbolAtLocation(node);
        if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
        const name = node.getText(sf);
        for (const d of sym?.declarations ?? []) {
          // Walk up: the resolved declaration may be the name inside the
          // declaration node we registered (e.g. VariableDeclaration).
          let cur: ts.Node | undefined = d;
          while (cur) {
            const id = declToId.get(cur);
            if (id) return { id, name };
            cur = cur.parent;
          }
        }
        return { id: null, name };
      };

      const enclosingSymbolId = (node: ts.Node): string => {
        let cur: ts.Node | undefined = node.parent;
        while (cur) {
          const id = declToId.get(cur);
          if (id) return id;
          cur = cur.parent;
        }
        return moduleId;
      };

      const addEdge = (fromId: string, target: { id: string | null; name: string }, kind: EdgeKind) => {
        if (target.id === fromId) return; // self loops are noise
        bucket.edges.push({
          fromId,
          toId: target.id,
          toName: target.name,
          kind,
          resolved: target.id !== null,
        });
      };

      const visit = (node: ts.Node) => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          const resolvedModule = checker.getSymbolAtLocation(node.moduleSpecifier);
          const targetSf = resolvedModule?.declarations?.find(ts.isSourceFile);
          const targetId = targetSf ? declToId.get(targetSf) ?? null : null;
          addEdge(moduleId, { id: targetId, name: node.moduleSpecifier.text }, 'imports');
        } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
          const callee = calleeNameNode(node.expression);
          if (callee) addEdge(enclosingSymbolId(node), resolveTarget(callee), 'calls');
        } else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          // Rendering a component is the JSX analogue of a call.
          const tag = node.tagName;
          if (!ts.isIdentifier(tag) || /^[A-Z]/.test(tag.text)) {
            addEdge(enclosingSymbolId(node), resolveTarget(tag), 'calls');
          }
        } else if (ts.isHeritageClause(node)) {
          for (const t of node.types) {
            const callee = calleeNameNode(t.expression);
            if (callee) addEdge(enclosingSymbolId(node), resolveTarget(callee), 'extends');
          }
        } else if (ts.isIdentifier(node) && isBareReference(node)) {
          const target = resolveTarget(node);
          if (target.id) addEdge(enclosingSymbolId(node), target, 'references');
        }
        node.forEachChild(visit);
      };
      sf.forEachChild(visit);
    }

    return [...perFile.entries()].map(([file, { symbols, edges }]) => ({
      file,
      symbols,
      edges: dedupeEdges(edges),
    }));
  }
}

/**
 * Test-runner blocks whose callbacks become `testblock` symbols. Without
 * this, every edge out of a test file originates from the whole-file module
 * symbol, which is too expensive to ever pack into a context budget
 * (Phase-0 report, failure mode 2). Framework-specific by necessity;
 * extend the set when a new runner shows up in a target repo.
 */
const TEST_BLOCK_CALLEES = new Set(['describe', 'it', 'test', 'suite']);

function testBlockCall(
  node: ts.Node
): { name: string; body: ts.Node } | null {
  if (!ts.isCallExpression(node)) return null;
  const callee = ts.isIdentifier(node.expression)
    ? node.expression.text
    : ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
      ? node.expression.expression.text // it.skip / describe.only
      : null;
  if (!callee || !TEST_BLOCK_CALLEES.has(callee)) return null;
  const title = node.arguments.find(ts.isStringLiteralLike)?.text;
  const body = node.arguments.find(
    (a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a)
  );
  if (!body) return null;
  return { name: `${callee}(${title ?? ''})`, body };
}

function classifyDeclaration(
  node: ts.Node
): { name: string; kind: SymbolKind; nameNode: ts.Node | null } | null {
  if (ts.isFunctionDeclaration(node) && node.name) {
    return { name: node.name.text, kind: 'function', nameNode: node.name };
  }
  if (ts.isClassDeclaration(node) && node.name) {
    return { name: node.name.text, kind: 'class', nameNode: node.name };
  }
  if (ts.isInterfaceDeclaration(node)) {
    return { name: node.name.text, kind: 'interface', nameNode: node.name };
  }
  if (ts.isTypeAliasDeclaration(node)) {
    return { name: node.name.text, kind: 'typealias', nameNode: node.name };
  }
  if (ts.isEnumDeclaration(node)) {
    return { name: node.name.text, kind: 'enum', nameNode: node.name };
  }
  if ((ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) && node.parent && ts.isClassLike(node.parent)) {
    const name = ts.isConstructorDeclaration(node)
      ? 'constructor'
      : ts.isIdentifier(node.name)
        ? node.name.text
        : node.name.getText();
    return { name, kind: 'method', nameNode: ts.isConstructorDeclaration(node) ? null : node.name };
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
    // Only top-level(-ish) const bindings: arrow-function components, services…
    const stmt = node.parent?.parent;
    if (stmt && ts.isVariableStatement(stmt) && ts.isSourceFile(stmt.parent)) {
      const isFn = ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer);
      return { name: node.name.text, kind: isFn ? 'function' : 'variable', nameNode: node.name };
    }
  }
  return null;
}

/** For `a.b.c(...)` return the rightmost name; for `f(...)` the identifier. */
function calleeNameNode(expr: ts.Expression): ts.Node | null {
  if (ts.isIdentifier(expr)) return expr;
  if (ts.isPropertyAccessExpression(expr)) return expr.name;
  return null;
}

/**
 * Identifiers worth a `references` edge: used as a value but not the callee
 * of a call (those are `calls`), not a declaration name, not a property name.
 * Catches e.g. a function passed as a JSX prop or callback.
 */
function isBareReference(node: ts.Identifier): boolean {
  const p = node.parent;
  if (!p) return false;
  if (ts.isCallExpression(p) && p.expression === node) return false;
  if (ts.isNewExpression(p) && p.expression === node) return false;
  if (ts.isPropertyAccessExpression(p) && p.name === node) return false;
  if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)) return false;
  if (ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxClosingElement(p)) return false;
  if (
    (ts.isFunctionDeclaration(p) ||
      ts.isClassDeclaration(p) ||
      ts.isInterfaceDeclaration(p) ||
      ts.isTypeAliasDeclaration(p) ||
      ts.isEnumDeclaration(p) ||
      ts.isVariableDeclaration(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isParameter(p) ||
      ts.isBindingElement(p) ||
      ts.isPropertyAssignment(p) ||
      ts.isPropertySignature(p) ||
      ts.isPropertyDeclaration(p)) &&
    (p as { name?: ts.Node }).name === node
  ) {
    return false;
  }
  return true;
}

function signatureOf(node: ts.Node, sf: ts.SourceFile): string | null {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  ) {
    const params = node.parameters.map((p) => p.getText(sf)).join(', ');
    const ret = node.type ? `: ${node.type.getText(sf)}` : '';
    return `(${params})${ret}`;
  }
  if (ts.isVariableDeclaration(node) && node.initializer && ts.isArrowFunction(node.initializer)) {
    const params = node.initializer.parameters.map((p) => p.getText(sf)).join(', ');
    return `(${params})`;
  }
  return null;
}

function docOf(node: ts.Node): string | null {
  const tags = ts.getJSDocCommentsAndTags(node);
  for (const t of tags) {
    if (ts.isJSDoc(t) && t.comment) {
      return typeof t.comment === 'string' ? t.comment : t.comment.map((c) => c.text).join('');
    }
  }
  return null;
}

function dedupeEdges(edges: EdgeRow[]): EdgeRow[] {
  const seen = new Set<string>();
  return edges.filter((e) => {
    const key = `${e.fromId}|${e.toId ?? ''}|${e.toName}|${e.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface IndexReport {
  root: string;
  filesSeen: number;
  filesIndexed: number;
  filesUnchanged: number;
  filesRemoved: number;
  symbols: number;
  edges: number;
  unresolvedEdges: number;
  durationMs: number;
}

/**
 * Index `rootDir` into `store`. Incremental at the persistence layer: rows are
 * rewritten only for files whose content hash changed (parse is still whole-
 * program per extractor — cross-file resolution needs it; see dlog for the
 * deferral).
 *
 * Dispatch (#10): files are discovered for the union of the registered
 * extractors' extensions, routed to the first extractor that claims them,
 * and every extractor's rows merge into the same store. An extractor only
 * runs when at least one of ITS files changed.
 */
export function indexRepo(
  store: Store,
  rootDir: string,
  opts: { extractors?: Extractor[] } = {}
): IndexReport {
  const t0 = Date.now();
  const extractors = opts.extractors ?? defaultExtractors();
  const allExtensions = [...new Set(extractors.flatMap((x) => x.extensions))];
  const absFiles = discoverSourceFiles(rootDir, allExtensions);
  const rel = (abs: string) => relative(rootDir, abs).split(sep).join('/');

  const hashes = new Map<string, string>();
  for (const abs of absFiles) hashes.set(rel(abs), contentHash(readFileSync(abs, 'utf8')));

  const known = new Map(store.listFiles().map((f) => [f.path, f.hash]));
  const removed = [...known.keys()].filter((p) => !hashes.has(p));
  store.removeFiles(removed);

  const changedSet = new Set(
    [...hashes.entries()].filter(([p, h]) => known.get(p) !== h).map(([p]) => p)
  );

  let indexed = 0;
  for (const extractor of extractors) {
    const claimed = absFiles.filter((abs) => extractorFor(rel(abs), extractors) === extractor);
    if (claimed.length === 0 || !claimed.some((abs) => changedSet.has(rel(abs)))) continue;
    for (const r of extractor.extract(rootDir, claimed)) {
      if (!changedSet.has(r.file)) continue;
      store.replaceFile(r.file, hashes.get(r.file)!, r.symbols, r.edges);
      indexed++;
    }
  }
  store.setMeta('root', rootDir);
  store.setMeta('last_indexed_at', String(Date.now()));

  const s = store.stats();
  return {
    root: rootDir,
    filesSeen: absFiles.length,
    filesIndexed: indexed,
    filesUnchanged: absFiles.length - indexed,
    filesRemoved: removed.length,
    symbols: s.symbols,
    edges: s.edges,
    unresolvedEdges: s.unresolvedEdges,
    durationMs: Date.now() - t0,
  };
}
