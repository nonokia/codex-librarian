/**
 * SCIP+ ingest — the mapping from SCIP back to ExtractionResult rows
 * (docs/scip-design.md §4.5). Two routes share this module:
 *
 * Native (scipPlusToExtractionResults): symbols come from the base layer
 * (SymbolInformation + definition occurrences), overlaid by ext for what base
 * cannot carry as first-class (testblocks). Edges come exclusively from ext —
 * the source of truth; base occurrences are never re-derived (design §3-1).
 *
 * Degrade (scipIndexToExtractionResults): ext-less external `.scip` files.
 * Edges ARE re-derived from base occurrences — Import role → imports,
 * is_implementation → extends, every other reference → references; the
 * call/reference distinction cannot survive base SCIP. Testblocks partially
 * reconstruct from SymbolRole.Test definitions.
 */
import { SymbolRole } from '@scip-code/scip';
import type { Index } from '@scip-code/scip';
import { symbolId } from './extractor.js';
import type { ExtractedSymbol, ExtractionResult } from './extractor.js';
import type { EdgeKind, EdgeRow } from './store.js';
import {
  degradeKindFromScip,
  externalMonikerKey,
  isLocalSymbol,
  kindFromScip,
  monikerToId,
  monikerToParts,
  parseMoniker,
  scipRangeToSpan,
  type Ext,
} from './scip.js';

type ScipDocument = Index['documents'][number];
type ScipOccurrence = ScipDocument['occurrences'][number];

function spanOf(occ: ScipOccurrence | undefined): { spanStart: number; spanEnd: number } {
  const enclosing = occ?.typedEnclosingRange;
  if (enclosing?.case === 'multiLineEnclosingRange') return scipRangeToSpan(enclosing.value);
  if (enclosing?.case === 'singleLineEnclosingRange') return scipRangeToSpan(enclosing.value);
  return { spanStart: 1, spanEnd: 1 };
}

export function scipPlusToExtractionResults(index: Index, ext: Ext): ExtractionResult[] {
  const extByPath = new Map(ext.documents.map((d) => [d.relativePath, d]));
  // moniker → id is repo-global (edges cross documents); locals are per-document
  const idByMoniker = new Map<string, string>();

  // Pass 1 — symbol rows per document, in base-layer order (which is the
  // extractor's collection order). Locals take their truth from ext.
  const docs = index.documents.map((doc) => {
    const extDoc = extByPath.get(doc.relativePath);
    const extSymbol = new Map((extDoc?.symbols ?? []).map((s) => [s.symbol, s]));
    const defOcc = new Map<string, ScipOccurrence>();
    for (const occ of doc.occurrences) {
      if (occ.symbolRoles & SymbolRole.Definition && !defOcc.has(occ.symbol)) {
        defOcc.set(occ.symbol, occ);
      }
    }

    const symbols: ExtractedSymbol[] = [];
    const localToId = new Map<string, string>();
    for (const si of doc.symbols) {
      if (isLocalSymbol(si.symbol)) {
        const es = extSymbol.get(si.symbol);
        if (!es) {
          throw new Error(`${doc.relativePath}: local symbol "${si.symbol}" has no ext entry`);
        }
        const id = symbolId(doc.relativePath, es.container, es.name, es.kind);
        localToId.set(si.symbol, id);
        symbols.push({
          id,
          kind: es.kind,
          name: es.name,
          file: doc.relativePath,
          container: es.container,
          spanStart: es.spanStart,
          spanEnd: es.spanEnd,
          // ext is a delta: signature/doc are base-expressible and live there
          // even for locals (a top-level TestXxx testblock has both)
          signature: si.signatureDocumentation?.text || null,
          doc: si.documentation[0] ?? null,
        });
        continue;
      }

      const kind = kindFromScip(si.kind);
      if (kind === null) {
        throw new Error(`${doc.relativePath}: no librarian kind for SCIP kind ${si.kind} (${si.symbol})`);
      }
      const key = monikerToParts(si.symbol);
      if (key.file !== doc.relativePath) {
        throw new Error(
          `${doc.relativePath}: moniker is rooted at "${key.file}" — librarian documents own their symbols`,
        );
      }
      const span = spanOf(defOcc.get(si.symbol));
      const id = monikerToId(si.symbol, kind);
      idByMoniker.set(si.symbol, id);
      symbols.push({
        id,
        kind,
        name: key.name,
        file: doc.relativePath,
        container: key.container,
        spanStart: span.spanStart,
        spanEnd: span.spanEnd,
        signature: si.signatureDocumentation?.text || null,
        doc: si.documentation[0] ?? null,
      });
    }
    return { doc, extDoc, symbols, localToId };
  });

  // Pass 2 — edges from ext, resolvable only once the repo-global moniker
  // table is complete.
  return docs.map(({ doc, extDoc, symbols, localToId }) => {
    const at = doc.relativePath;
    const refId = (sym: string): string => {
      const id = localToId.get(sym) ?? idByMoniker.get(sym);
      if (id === undefined) throw new Error(`${at}: edge references unknown symbol "${sym}"`);
      return id;
    };
    const edges: EdgeRow[] = (extDoc?.edges ?? []).map((edge) => ({
      fromId: refId(edge.from),
      toId: edge.to === null ? null : refId(edge.to),
      toName: edge.toName,
      kind: edge.kind,
      resolved: edge.resolved,
    }));
    return { file: at, symbols, edges };
  });
}

// ---------------------------------------------------------------------------
// Degrade route (design §4.5) — external `.scip` without an ext sidecar.
// ---------------------------------------------------------------------------

/**
 * Older producers (e.g. scip-python 0.6.x) still emit the deprecated
 * `repeated int32` ranges instead of the typed oneofs; consumers fall back
 * per the scip.proto contract. Three elements = single line.
 */
function legacyRangeToSpan(range: number[]): { spanStart: number; spanEnd: number } | null {
  if (range.length === 3) return { spanStart: range[0] + 1, spanEnd: range[0] + 1 };
  if (range.length === 4) {
    const spanStart = range[0] + 1;
    // half-open: an end at column 0 excludes its line (mirrors scipRangeToSpan)
    const spanEnd = range[3] === 0 && range[2] > range[0] ? range[2] : range[2] + 1;
    return { spanStart, spanEnd: Math.max(spanEnd, spanStart) };
  }
  return null;
}

function occurrenceSpan(occ: ScipOccurrence): { spanStart: number; spanEnd: number } {
  if (occ.typedRange.case !== undefined) return scipRangeToSpan(occ.typedRange.value);
  return legacyRangeToSpan(occ.range) ?? { spanStart: 1, spanEnd: 1 };
}

/** Definition span: the enclosing range (either encoding) when present, else the name range. */
function definitionSpan(occ: ScipOccurrence): { spanStart: number; spanEnd: number } {
  const typed = occ.typedEnclosingRange;
  if (typed.case !== undefined) return scipRangeToSpan(typed.value);
  return legacyRangeToSpan(occ.enclosingRange) ?? occurrenceSpan(occ);
}

/** Display name for edge endpoints: the last naming descriptor; scip-python names modules `__init__` — prefer the module path segment then. */
function monikerDisplayName(moniker: string): string | null {
  let descriptors;
  try {
    descriptors = parseMoniker(moniker).descriptors;
  } catch {
    return null;
  }
  for (let i = descriptors.length - 1; i >= 0; i--) {
    const d = descriptors[i];
    if (d.suffix === 'parameter' || d.suffix === 'typeParameter') continue;
    if (d.name === '__init__' && i > 0) continue;
    return d.name;
  }
  return null;
}

export interface DegradeIngest {
  results: ExtractionResult[];
  /** doc-owned symbols dropped (unmappable kind, unparsable moniker, id collision) — reported, never silent */
  skippedSymbols: number;
}

/**
 * Map a bare SCIP index (no ext) to rows. Symbol ownership = having a
 * definition occurrence in the document; everything else in doc.symbols is a
 * cross-document listing. References to symbols with no definition anywhere
 * in the index stay first-class as unresolved edges — imports of external
 * packages are most of a real repo's import signal, and `map`'s unresolved
 * accounting (§8-2, measurability over completeness) needs them.
 */
export function scipIndexToExtractionResults(index: Index): DegradeIngest {
  let skippedSymbols = 0;
  const idByMoniker = new Map<string, string>();

  // Pass 1 — doc-owned rows; the moniker→id table must be complete before edges.
  const docs = index.documents.map((doc) => {
    const file = doc.relativePath;
    const defOcc = new Map<string, ScipOccurrence>();
    for (const occ of doc.occurrences) {
      if (occ.symbolRoles & SymbolRole.Definition && !defOcc.has(occ.symbol)) {
        defOcc.set(occ.symbol, occ);
      }
    }

    // every librarian extractor emits a module row per file; synthesize the
    // same anchor here (producer-side module/file symbols map to null kinds)
    const moduleRow: ExtractedSymbol = {
      id: symbolId(file, null, file, 'module'),
      kind: 'module',
      name: file,
      file,
      container: null,
      spanStart: 1,
      spanEnd: 1,
      signature: null,
      doc: null,
    };
    const rows: ExtractedSymbol[] = [moduleRow];
    const usedIds = new Set<string>([moduleRow.id]);
    const rowByMoniker = new Map<string, ExtractedSymbol>();
    const siBySymbol = new Map(doc.symbols.map((si) => [si.symbol, si]));

    for (const si of doc.symbols) {
      if (isLocalSymbol(si.symbol)) continue; // locals: only Test-role ones matter, below
      const occ = defOcc.get(si.symbol);
      if (occ === undefined) continue; // referenced-only listing, owned elsewhere
      const kind = degradeKindFromScip(si.kind);
      const key = externalMonikerKey(si.symbol);
      if (kind === null || key === null) {
        skippedSymbols++;
        continue;
      }
      const id = symbolId(file, key.container, key.name, kind);
      if (usedIds.has(id)) {
        // e.g. overloads distinguished only by a method disambiguator
        skippedSymbols++;
        continue;
      }
      usedIds.add(id);
      const span = definitionSpan(occ);
      const row: ExtractedSymbol = {
        id,
        kind,
        name: key.name,
        file,
        container: key.container,
        spanStart: span.spanStart,
        spanEnd: span.spanEnd,
        signature: si.signatureDocumentation?.text || null,
        doc: si.documentation[0] ?? null,
      };
      rows.push(row);
      rowByMoniker.set(si.symbol, row);
      if (!idByMoniker.has(si.symbol)) idByMoniker.set(si.symbol, id);
    }

    // testblocks — partial reconstruction (design §4.5): Test-role local
    // definitions; nesting only through span containment, outermost first
    const testDefs = doc.occurrences
      .filter(
        (occ) =>
          isLocalSymbol(occ.symbol) &&
          occ.symbolRoles & SymbolRole.Definition &&
          occ.symbolRoles & SymbolRole.Test,
      )
      .map((occ) => ({ occ, span: definitionSpan(occ) }))
      .sort((a, b) => a.span.spanStart - b.span.spanStart || b.span.spanEnd - a.span.spanEnd);
    for (const { occ, span } of testDefs) {
      const si = siBySymbol.get(occ.symbol);
      const name = si?.displayName || occ.symbol;
      const enclosing = innermostEnclosing(rows, moduleRow, span.spanStart, span.spanEnd);
      const container =
        enclosing === moduleRow
          ? null
          : enclosing.container
            ? `${enclosing.container}.${enclosing.name}`
            : enclosing.name;
      const id = symbolId(file, container, name, 'testblock');
      if (usedIds.has(id)) {
        skippedSymbols++;
        continue;
      }
      usedIds.add(id);
      const row: ExtractedSymbol = {
        id,
        kind: 'testblock',
        name,
        file,
        container,
        spanStart: span.spanStart,
        spanEnd: span.spanEnd,
        signature: si?.signatureDocumentation?.text || null,
        doc: si?.documentation[0] ?? null,
      };
      rows.push(row);
      rowByMoniker.set(occ.symbol, row);
    }

    moduleRow.spanEnd = Math.max(1, ...rows.map((r) => r.spanEnd));
    return { doc, file, rows, moduleRow, rowByMoniker };
  });

  // Pass 2 — edges from occurrences and relationships.
  const results = docs.map(({ doc, file, rows, moduleRow, rowByMoniker }) => {
    const edges: EdgeRow[] = [];
    const seen = new Set<string>();
    const push = (e: EdgeRow) => {
      const k = `${e.fromId} ${e.toId ?? ''} ${e.toName} ${e.kind}`;
      if (seen.has(k)) return;
      seen.add(k);
      edges.push(e);
    };

    for (const occ of doc.occurrences) {
      if (occ.symbolRoles & SymbolRole.Definition) continue;
      if (occ.symbol === '' || isLocalSymbol(occ.symbol)) continue;
      const toName = monikerDisplayName(occ.symbol);
      if (toName === null) continue;
      const line = occurrenceSpan(occ).spanStart;
      const from = innermostEnclosing(rows, moduleRow, line, line);
      const toId = idByMoniker.get(occ.symbol) ?? null;
      const kind: EdgeKind = occ.symbolRoles & SymbolRole.Import ? 'imports' : 'references';
      push({ fromId: from.id, toId, toName, kind, resolved: toId !== null });
    }

    for (const si of doc.symbols) {
      const row = rowByMoniker.get(si.symbol);
      if (row === undefined) continue;
      for (const rel of si.relationships) {
        if (!rel.isImplementation) continue;
        const toName = monikerDisplayName(rel.symbol);
        if (toName === null) continue;
        const toId = idByMoniker.get(rel.symbol) ?? null;
        push({ fromId: row.id, toId, toName, kind: 'extends', resolved: toId !== null });
      }
    }
    return { file, symbols: rows, edges };
  });

  return { results, skippedSymbols };
}

/** innermost non-module row whose span contains [start, end], else the module row */
function innermostEnclosing(
  rows: ExtractedSymbol[],
  moduleRow: ExtractedSymbol,
  start: number,
  end: number,
): ExtractedSymbol {
  let best: ExtractedSymbol | null = null;
  for (const r of rows) {
    if (r === moduleRow) continue;
    if (r.spanStart <= start && end <= r.spanEnd) {
      if (best === null || r.spanEnd - r.spanStart < best.spanEnd - best.spanStart) best = r;
    }
  }
  return best ?? moduleRow;
}
