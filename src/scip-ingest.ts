/**
 * SCIP+ ingest — the native-path mapping from a SCIP+ envelope back to
 * ExtractionResult rows (docs/scip-design.md §4.5).
 *
 * Symbols come from the base layer (SymbolInformation + definition
 * occurrences), overlaid by ext for what base cannot carry as first-class
 * (testblocks). Edges come exclusively from ext — the source of truth;
 * base occurrences are never re-derived on the native path (design §3-1).
 * The degrade path for ext-less external `.scip` files is Step 4 of the
 * design and does not live here yet.
 */
import { SymbolRole } from '@scip-code/scip';
import type { Index } from '@scip-code/scip';
import { symbolId } from './extractor.js';
import type { ExtractedSymbol, ExtractionResult } from './extractor.js';
import type { EdgeRow } from './store.js';
import {
  isLocalSymbol,
  kindFromScip,
  monikerToId,
  monikerToParts,
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
