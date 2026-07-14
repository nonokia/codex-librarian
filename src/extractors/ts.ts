/**
 * TypeScript extractor — type-resolved symbol/edge extraction (architecture §4-①, ADR-2).
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
import { relative, sep } from 'node:path';
import type { EdgeKind, EdgeRow, SymbolKind } from '../store/store.js';
import { symbolId } from '../protocol/extractor.js';
import type { ExtractedSymbol, ExtractionResult, Extractor } from '../protocol/extractor.js';
import { extractionResultsToScipPlus } from '../protocol/scip-emit.js';
import { scipPlusToExtractionResults } from '../protocol/scip-ingest.js';

export const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

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
    const perFile = new Map<string, { symbols: ExtractedSymbol[]; edges: EdgeRow[] }>();

    for (const sf of program.getSourceFiles()) {
      if (!inRepo.has(sf.fileName)) continue;
      const file = rel(sf.fileName);
      const bucket = { symbols: [] as ExtractedSymbol[], edges: [] as EdgeRow[] };
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

      /**
       * The package a name is bound from, when the import that brought it in
       * does not resolve inside the repo — `<specifier>#<imported>` (#27).
       * Only an identifier the checker traced to an ImportSpecifier qualifies,
       * which is what keeps `seen.add(v)` (a method named like an imported
       * `add`) out: its callee is a property, bound by nothing.
       */
      const externalBinding = (sym: ts.Symbol | undefined): string | null => {
        for (const d of sym?.declarations ?? []) {
          if (!ts.isImportSpecifier(d)) continue;
          const decl = d.parent.parent.parent;
          if (!ts.isStringLiteral(decl.moduleSpecifier)) continue;
          const targetSf = checker
            .getSymbolAtLocation(decl.moduleSpecifier)
            ?.declarations?.find(ts.isSourceFile);
          if (targetSf && declToId.has(targetSf)) return null; // in-repo: resolves normally
          return `${decl.moduleSpecifier.text}#${(d.propertyName ?? d.name).text}`;
        }
        return null;
      };

      const resolveTarget = (node: ts.Node): { id: string | null; name: string } => {
        const local = checker.getSymbolAtLocation(node);
        let sym = local;
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
        // Unresolved. A bare name cannot be attributed to anything later, so
        // when the name IS an external import, say so: the edge carries the
        // package it came from, and `librarian link` (#27) needs no guessing.
        return { id: null, name: externalBinding(local) ?? name };
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
          const spec = node.moduleSpecifier.text;
          addEdge(moduleId, { id: targetId, name: spec }, 'imports');
          if (targetId === null) for (const b of importBindings(node, spec)) {
            addEdge(moduleId, { id: null, name: b }, 'imports');
          }
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

    const results = [...perFile.entries()].map(([file, { symbols, edges }]) => ({
      file,
      symbols,
      edges: dedupeEdges(edges),
    }));
    // Route through the SCIP+ contract (emit → ingest, issue #16 Step 3) so
    // the in-process TS extractor speaks the same envelope as the Go/PHP
    // child processes; ingest recomputes every row from the envelope alone.
    const { index, ext } = extractionResultsToScipPlus('librarian-ts', rootDir, results);
    return scipPlusToExtractionResults(index, ext);
  }
}

/**
 * Named bindings of an import the repo cannot resolve — i.e. an external
 * package (#27) — as `imports` edges of their own: `<specifier>#<imported>`,
 * or `<specifier>#<imported> as <local>` when the local name differs. They say
 * which external names a file depends on, and give `librarian link` the edge to
 * resolve for the import itself. The *use* sites are named by `externalBinding`
 * above, so linking never has to match a bare name against a package.
 *
 * Default and namespace imports are deliberately not emitted: their use sites
 * carry a local alias or a property access, which cannot be bound back to a
 * declaration name without type resolution. They stay unresolved — the
 * invariant is no false edges, not completeness.
 */
function importBindings(node: ts.ImportDeclaration, spec: string): string[] {
  const named = node.importClause?.namedBindings;
  if (!named || !ts.isNamedImports(named)) return [];
  return named.elements.map((el) => {
    const imported = (el.propertyName ?? el.name).text;
    const local = el.name.text;
    return local === imported ? `${spec}#${imported}` : `${spec}#${imported} as ${local}`;
  });
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
