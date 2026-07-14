/**
 * SCIP+ emit — the generic mapping from ExtractionResult rows to a SCIP+
 * envelope (docs/scip-design.md §4.3; the emit half of scip-ingest.ts).
 *
 * The in-process TS extractor routes through emit → ingest so all three
 * languages speak the same contract (issue #16 Step 3), and Step 4's
 * `librarian export --scip` can reuse this for store-level export. Rows
 * carry no name columns or reference positions, so the base layer projects
 * definition occurrences with empty ranges at the span's first line and no
 * reference occurrences — weaker than the Go emitter's base layer (which has
 * real positions) — while ext still carries every edge, so retrieval
 * signals lose nothing.
 */
import type { MessageInitShape } from '@bufbuild/protobuf';
import {
  DocumentSchema,
  OccurrenceSchema,
  PositionEncoding,
  SymbolInformationSchema,
  SymbolRole,
  TextEncoding,
} from '@scip-code/scip';
import type { Index } from '@scip-code/scip';
import type { ExtractedSymbol, ExtractionResult } from './extractor.js';
import {
  KIND_TO_SCIP,
  createScipIndex,
  formatLocal,
  formatMoniker,
  isLocalSymbol,
  spanToScipRange,
  type Ext,
  type ExtDocument,
  type LibrarianScheme,
} from './scip.js';

const LANGUAGE: Record<LibrarianScheme, string> = {
  'librarian-ts': 'typescript',
  'librarian-go': 'go',
  'librarian-php': 'php',
  'librarian-py': 'python',
  'librarian-terraform': 'terraform',
};

/** innermost row strictly enclosing the testblock's span — its enclosing_symbol */
function parentOf(rows: ExtractedSymbol[], tb: ExtractedSymbol): ExtractedSymbol | null {
  let best: ExtractedSymbol | null = null;
  for (const s of rows) {
    if (s === tb) continue;
    if (s.spanStart <= tb.spanStart && tb.spanEnd <= s.spanEnd) {
      if (best === null || s.spanEnd - s.spanStart < best.spanEnd - best.spanStart) best = s;
    }
  }
  return best;
}

export function extractionResultsToScipPlus(
  scheme: LibrarianScheme,
  rootDir: string,
  results: ExtractionResult[],
): { index: Index; ext: Ext } {
  // scip symbol string per row id: moniker, or a document-local id for
  // testblocks, numbered in collection order.
  const scipName = new Map<string, string>();
  const fileOf = new Map<string, string>();
  for (const r of results) {
    let local = 0;
    for (const s of r.symbols) {
      fileOf.set(s.id, r.file);
      scipName.set(
        s.id,
        s.kind === 'testblock'
          ? formatLocal(local++)
          : formatMoniker(scheme, {
              file: s.file,
              container: s.container,
              name: s.name,
              kind: s.kind,
            }),
      );
    }
  }

  const language = LANGUAGE[scheme];
  const documents: MessageInitShape<typeof DocumentSchema>[] = [];
  const extDocuments: ExtDocument[] = [];

  for (const r of results) {
    const occurrences: MessageInitShape<typeof OccurrenceSchema>[] = [];
    const symbols: MessageInitShape<typeof SymbolInformationSchema>[] = [];
    const extDoc: ExtDocument = { relativePath: r.file, symbols: [], edges: [] };

    // extends edges become is_implementation relationships on the from-symbol
    const relsByFrom = new Map<string, { symbol: string; isImplementation: boolean }[]>();
    for (const e of r.edges) {
      if (e.kind !== 'extends' || e.toId === null) continue;
      const target = scipName.get(e.toId);
      if (target === undefined) continue;
      const rels = relsByFrom.get(e.fromId) ?? [];
      rels.push({ symbol: target, isImplementation: true });
      relsByFrom.set(e.fromId, rels);
    }

    for (const s of r.symbols) {
      const sym = scipName.get(s.id)!;
      occurrences.push({
        symbol: sym,
        symbolRoles: SymbolRole.Definition | (s.kind === 'testblock' ? SymbolRole.Test : 0),
        // rows carry no name columns — an empty range at the span's first line
        typedRange: {
          case: 'singleLineRange',
          value: { line: s.spanStart - 1, startCharacter: 0, endCharacter: 0 },
        },
        typedEnclosingRange: {
          case: 'multiLineEnclosingRange',
          value: spanToScipRange(s.spanStart, s.spanEnd),
        },
      });

      const relationships = relsByFrom.get(s.id);
      symbols.push({
        symbol: sym,
        displayName: s.name,
        ...(s.kind !== 'testblock' && { kind: KIND_TO_SCIP[s.kind] }),
        ...(s.doc !== null && { documentation: [s.doc] }),
        ...(s.signature !== null && { signatureDocumentation: { language, text: s.signature } }),
        ...(relationships !== undefined && { relationships }),
        ...(s.kind === 'testblock' &&
          (() => {
            const parent = parentOf(r.symbols, s);
            return parent !== null && { enclosingSymbol: scipName.get(parent.id)! };
          })()),
      });

      if (s.kind === 'testblock') {
        extDoc.symbols.push({
          symbol: sym,
          kind: s.kind,
          name: s.name,
          container: s.container,
          spanStart: s.spanStart,
          spanEnd: s.spanEnd,
        });
      }
    }

    for (const e of r.edges) {
      const from = scipName.get(e.fromId);
      if (from === undefined) {
        throw new Error(`${r.file}: edge from unknown symbol id ${e.fromId}`);
      }
      let to: string | null = null;
      if (e.toId !== null) {
        const target = scipName.get(e.toId);
        if (target === undefined) {
          console.error(`warn: ${r.file}: resolved edge to unknown id ${e.toId} — kept unresolved`);
        } else if (isLocalSymbol(target) && fileOf.get(e.toId) !== r.file) {
          // a local of another document is unrepresentable on both layers
          console.error(`warn: ${r.file}: dropping cross-file edge into a test block`);
        } else {
          to = target;
        }
      }
      extDoc.edges.push({ from, to, toName: e.toName, kind: e.kind, resolved: to !== null });
      // no reference occurrences: rows carry no positions (see module comment)
    }

    documents.push({
      language,
      relativePath: r.file,
      positionEncoding: PositionEncoding.UTF8CodeUnitOffsetFromLineStart,
      occurrences,
      symbols,
    });
    extDocuments.push(extDoc);
  }

  const index = createScipIndex({
    metadata: {
      toolInfo: { name: scheme, version: '0.1.0' },
      projectRoot: 'file://' + rootDir,
      textDocumentEncoding: TextEncoding.UTF8,
    },
    documents,
  });
  return { index, ext: { version: 1, documents: extDocuments } };
}
