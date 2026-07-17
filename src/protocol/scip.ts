/**
 * SCIP+ boundary — the single place where SCIP enters or leaves the process
 * (docs/scip-design.md §4, issue #16 / ADR-6).
 *
 * Three things live here and nowhere else:
 *  - the SCIP+ envelope / ext-sidecar types (the extractor → indexer contract),
 *  - protobuf encode/decode for `.scip` payloads (base layer, standards-compliant),
 *  - the deterministic moniker ⇄ symbol-id mapping shared by emit and ingest.
 *
 * The ext sidecar — not base SCIP — is the source of truth for retrieval
 * signals: scip.proto has no `call` SymbolRole (so calls vs references cannot
 * survive the base layer) and cannot express unresolved references. Base SCIP
 * is a lossy, standards-compliant projection; native-path ingest never
 * re-derives edges from base occurrences (design §3-1).
 */
import {
  create,
  fromBinary,
  fromJson,
  toBinary,
  toJson,
  type JsonValue,
  type MessageInitShape,
} from '@bufbuild/protobuf';
import { IndexSchema, SymbolInformation_Kind } from '@scip-code/scip';
import type { Index } from '@scip-code/scip';
import { symbolId } from './extractor.js';
import type { EdgeKind, SymbolKind } from '../store/store.js';

// ---------------------------------------------------------------------------
// SCIP+ envelope & ext sidecar (design §4.1, §4.4)
// ---------------------------------------------------------------------------

/**
 * The extractor → indexer contract: one JSON envelope on the child process's
 * stdout. `scip` is a scip.Index in proto3 canonical JSON (Go emits it with
 * protojson, PHP hand-builds it); protobuf *binary* never crosses the process
 * boundary — it exists only at the `.scip` file boundary (encode/decodeScip).
 */
export interface ScipPlusEnvelope {
  scip: JsonValue;
  ext: Ext;
}

// ---------------------------------------------------------------------------
// Plugin protocol identity & capabilities handshake (issue #22 / ADR-7)
// ---------------------------------------------------------------------------

/**
 * The wire contract IS the SCIP+ envelope; the plugin protocol adds only
 * discovery/registration and this handshake. A subprocess plugin, invoked with
 * `--capabilities` (and no stdin), prints one Capabilities JSON line so the
 * runner can negotiate the envelope major version before extracting.
 */
export const PROTOCOL_NAME = 'librarian-scip-plus';

/** Envelope major version this runner speaks. Grows only on a breaking change. */
export const PROTOCOL_VERSION = 1;

export interface Capabilities {
  /** always PROTOCOL_NAME — identifies the envelope contract */
  protocol: string;
  /** envelope major the plugin speaks; the runner speaks PROTOCOL_VERSION */
  protocolVersion: number;
  /** the plugin's moniker scheme / ToolInfo.name, e.g. 'librarian-go' */
  name: string;
  /** extensions the plugin claims, e.g. ['.go'] */
  extensions: string[];
}

/**
 * Ext is a delta on top of base SCIP, never a restatement of it: symbols the
 * base layer cannot carry as first-class (testblocks), and the edge list that
 * is the source of truth for retrieval. Consumers ignore unknown fields;
 * future revisions only add.
 */
export interface Ext {
  version: 1;
  documents: ExtDocument[];
}

/** Mirrors ExtractionResult's file granularity so Store.replaceFile keeps working. */
export interface ExtDocument {
  relativePath: string;
  symbols: ExtSymbol[];
  edges: ExtEdge[];
}

export interface ExtSymbol {
  /** moniker, or a `local N` id scoped to this document (testblocks) */
  symbol: string;
  kind: SymbolKind;
  name: string;
  container: string | null;
  /** 1-based inclusive line span, as stored in SymbolRow */
  spanStart: number;
  spanEnd: number;
}

export interface ExtEdge {
  /** moniker or document-scoped `local N` */
  from: string;
  /** null iff unresolved — a concept base SCIP cannot express */
  to: string | null;
  toName: string;
  kind: EdgeKind;
  resolved: boolean;
}

// Exhaustive-record trick: adding a kind to store.ts without updating these
// sets is a compile error, so envelope validation can't silently drift.
const SYMBOL_KIND_FLAGS: Record<SymbolKind, true> = {
  module: true,
  function: true,
  method: true,
  class: true,
  struct: true,
  interface: true,
  trait: true,
  typealias: true,
  enum: true,
  variable: true,
  testblock: true,
  resource: true,
  data: true,
  output: true,
  locals: true,
  table: true,
  view: true,
  matview: true,
  procedure: true,
  trigger: true,
  index: true,
};
const EDGE_KIND_FLAGS: Record<EdgeKind, true> = {
  calls: true,
  imports: true,
  extends: true,
  references: true,
  // Framework-convention dynamic dispatch (#43 / ADR-9): a runtime transition
  // the language grammar cannot see (CakePHP redirect/setAction). Emitted
  // resolved=false by the plugin, bound later by `resolve-dispatches`.
  dispatches: true,
};
const SYMBOL_KINDS = new Set(Object.keys(SYMBOL_KIND_FLAGS));
const EDGE_KINDS = new Set(Object.keys(EDGE_KIND_FLAGS));

/**
 * Validate and open a SCIP+ envelope (already JSON.parsed). The scip half is
 * validated by protobuf-es itself (unknown enum names, wrong shapes throw);
 * the ext half is validated field-by-field here.
 */
export function parseScipPlus(envelope: unknown): { index: Index; ext: Ext } {
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
    throw new Error('SCIP+ envelope must be a JSON object');
  }
  const e = envelope as Record<string, unknown>;
  if (e.scip === undefined || e.ext === undefined) {
    throw new Error('SCIP+ envelope requires both "scip" and "ext"');
  }
  return { index: scipFromJson(e.scip as JsonValue), ext: parseExt(e.ext) };
}

/**
 * Validate a plugin's `--capabilities` reply (already JSON.parsed). Structural
 * only — version negotiation (is protocolVersion one this runner speaks?) is
 * the runner's call, so a well-formed reply announcing an unknown major still
 * parses here and is rejected downstream with a clear message.
 */
export function parseCapabilities(raw: unknown): Capabilities {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('capabilities must be a JSON object');
  }
  const c = raw as Record<string, unknown>;
  if (c.protocol !== PROTOCOL_NAME) {
    throw new Error(
      `capabilities.protocol ${JSON.stringify(c.protocol)} is not ${JSON.stringify(PROTOCOL_NAME)}`
    );
  }
  if (!Number.isInteger(c.protocolVersion)) {
    throw new Error('capabilities.protocolVersion must be an integer');
  }
  if (typeof c.name !== 'string' || c.name === '') {
    throw new Error('capabilities.name must be a non-empty string');
  }
  if (!Array.isArray(c.extensions) || c.extensions.some((x) => typeof x !== 'string')) {
    throw new Error('capabilities.extensions must be an array of strings');
  }
  return {
    protocol: c.protocol,
    protocolVersion: c.protocolVersion as number,
    name: c.name,
    extensions: c.extensions as string[],
  };
}

/** Also the parser for a standalone `.scip-ext.json` sidecar (import path). */
export function parseExt(raw: unknown): Ext {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('ext must be a JSON object');
  }
  const ext = raw as Record<string, unknown>;
  if (ext.version !== 1) {
    throw new Error(`unsupported ext version ${JSON.stringify(ext.version)} (expected 1)`);
  }
  if (!Array.isArray(ext.documents)) throw new Error('ext.documents must be an array');
  return { version: 1, documents: ext.documents.map(parseExtDocument) };
}

function parseExtDocument(raw: unknown, i: number): ExtDocument {
  const at = `ext.documents[${i}]`;
  if (typeof raw !== 'object' || raw === null) throw new Error(`${at} must be an object`);
  const d = raw as Record<string, unknown>;
  if (typeof d.relativePath !== 'string' || d.relativePath === '') {
    throw new Error(`${at}.relativePath must be a non-empty string`);
  }
  if (!Array.isArray(d.symbols) || !Array.isArray(d.edges)) {
    throw new Error(`${at} must have symbols[] and edges[]`);
  }
  return {
    relativePath: d.relativePath,
    symbols: d.symbols.map((s, j) => parseExtSymbol(s, `${at}.symbols[${j}]`)),
    edges: d.edges.map((s, j) => parseExtEdge(s, `${at}.edges[${j}]`)),
  };
}

function parseExtSymbol(raw: unknown, at: string): ExtSymbol {
  if (typeof raw !== 'object' || raw === null) throw new Error(`${at} must be an object`);
  const s = raw as Record<string, unknown>;
  if (typeof s.symbol !== 'string' || s.symbol === '') throw new Error(`${at}.symbol must be a non-empty string`);
  if (typeof s.kind !== 'string' || !SYMBOL_KINDS.has(s.kind)) {
    throw new Error(`${at}.kind ${JSON.stringify(s.kind)} is not a SymbolKind`);
  }
  if (typeof s.name !== 'string') throw new Error(`${at}.name must be a string`);
  if (s.container !== null && typeof s.container !== 'string') {
    throw new Error(`${at}.container must be a string or null`);
  }
  if (!Number.isInteger(s.spanStart) || !Number.isInteger(s.spanEnd)) {
    throw new Error(`${at}.spanStart/spanEnd must be integers`);
  }
  return {
    symbol: s.symbol,
    kind: s.kind as SymbolKind,
    name: s.name,
    container: s.container as string | null,
    spanStart: s.spanStart as number,
    spanEnd: s.spanEnd as number,
  };
}

function parseExtEdge(raw: unknown, at: string): ExtEdge {
  if (typeof raw !== 'object' || raw === null) throw new Error(`${at} must be an object`);
  const e = raw as Record<string, unknown>;
  if (typeof e.from !== 'string' || e.from === '') throw new Error(`${at}.from must be a non-empty string`);
  if (e.to !== null && typeof e.to !== 'string') throw new Error(`${at}.to must be a string or null`);
  if (typeof e.toName !== 'string') throw new Error(`${at}.toName must be a string`);
  if (typeof e.kind !== 'string' || !EDGE_KINDS.has(e.kind)) {
    throw new Error(`${at}.kind ${JSON.stringify(e.kind)} is not an EdgeKind`);
  }
  if (typeof e.resolved !== 'boolean') throw new Error(`${at}.resolved must be a boolean`);
  return {
    from: e.from,
    to: e.to as string | null,
    toName: e.toName,
    kind: e.kind as EdgeKind,
    resolved: e.resolved,
  };
}

// ---------------------------------------------------------------------------
// Base-layer protobuf boundary (design §4.1)
// ---------------------------------------------------------------------------

export function encodeScip(index: Index): Uint8Array {
  return toBinary(IndexSchema, index);
}

export function decodeScip(bytes: Uint8Array): Index {
  return fromBinary(IndexSchema, bytes);
}

export function scipFromJson(json: JsonValue): Index {
  return fromJson(IndexSchema, json);
}

export function scipToJson(index: Index): JsonValue {
  return toJson(IndexSchema, index);
}

/** Convenience for tests and emit code; init is a plain nested object. */
export function createScipIndex(init: MessageInitShape<typeof IndexSchema>): Index {
  return create(IndexSchema, init);
}

// ---------------------------------------------------------------------------
// Kind mapping (design §4.3) — testblock deliberately absent: it has no SCIP
// Kind; in the base layer it is a local symbol whose definition occurrence
// carries SymbolRole.Test, and ext is its source of truth.
// ---------------------------------------------------------------------------

export const KIND_TO_SCIP: Record<Exclude<SymbolKind, 'testblock'>, SymbolInformation_Kind> = {
  module: SymbolInformation_Kind.File,
  function: SymbolInformation_Kind.Function,
  method: SymbolInformation_Kind.Method,
  class: SymbolInformation_Kind.Class,
  struct: SymbolInformation_Kind.Struct,
  interface: SymbolInformation_Kind.Interface,
  trait: SymbolInformation_Kind.Trait,
  typealias: SymbolInformation_Kind.TypeAlias,
  enum: SymbolInformation_Kind.Enum,
  variable: SymbolInformation_Kind.Variable,
  // Terraform (#9): four otherwise-unused SCIP kinds keep the inverse
  // (SCIP_TO_KIND) a bijection, so the native round-trip recovers the kind.
  // `module` blocks are NOT here — they reuse the `module → File` mapping and
  // are told apart from the file symbol by the moniker (descriptor vs bare).
  resource: SymbolInformation_Kind.Object,
  data: SymbolInformation_Kind.Value,
  output: SymbolInformation_Kind.Property,
  locals: SymbolInformation_Kind.Constant,
  // SQL (#36): six more otherwise-unused SCIP kinds, same bijection rule.
  // `module` (file) and `function` are reused from the existing rows.
  table: SymbolInformation_Kind.Type,
  view: SymbolInformation_Kind.Delegate,
  matview: SymbolInformation_Kind.Instance,
  procedure: SymbolInformation_Kind.Macro,
  trigger: SymbolInformation_Kind.Event,
  index: SymbolInformation_Kind.Key,
};

const SCIP_TO_KIND = new Map<SymbolInformation_Kind, SymbolKind>(
  (Object.entries(KIND_TO_SCIP) as [SymbolKind, SymbolInformation_Kind][]).map(([k, v]) => [v, k]),
);

export function kindFromScip(kind: SymbolInformation_Kind): SymbolKind | null {
  return SCIP_TO_KIND.get(kind) ?? null;
}

/**
 * Degrade-path kind mapping (design §4.5) — external producers use a far
 * wider Kind vocabulary than the strict inverse above. File/Module/Namespace/
 * Package deliberately map to null: the degrade ingest synthesizes one module
 * row per document (the librarian convention, name === file), so producer-side
 * module symbols would only duplicate that anchor. Parameters, type
 * parameters and other sub-symbol kinds also map to null — they are not
 * librarian symbols.
 */
const DEGRADE_KIND_FROM_SCIP = new Map<SymbolInformation_Kind, SymbolKind>([
  [SymbolInformation_Kind.Function, 'function'],
  [SymbolInformation_Kind.Method, 'method'],
  [SymbolInformation_Kind.AbstractMethod, 'method'],
  [SymbolInformation_Kind.Constructor, 'method'],
  [SymbolInformation_Kind.StaticMethod, 'method'],
  [SymbolInformation_Kind.SingletonMethod, 'method'],
  [SymbolInformation_Kind.TraitMethod, 'method'],
  [SymbolInformation_Kind.ProtocolMethod, 'method'],
  [SymbolInformation_Kind.PureVirtualMethod, 'method'],
  [SymbolInformation_Kind.Getter, 'method'],
  [SymbolInformation_Kind.Setter, 'method'],
  [SymbolInformation_Kind.Accessor, 'method'],
  [SymbolInformation_Kind.Class, 'class'],
  [SymbolInformation_Kind.SingletonClass, 'class'],
  [SymbolInformation_Kind.Struct, 'struct'],
  [SymbolInformation_Kind.Interface, 'interface'],
  [SymbolInformation_Kind.Protocol, 'interface'],
  [SymbolInformation_Kind.Trait, 'trait'],
  [SymbolInformation_Kind.TypeAlias, 'typealias'],
  [SymbolInformation_Kind.Enum, 'enum'],
  [SymbolInformation_Kind.EnumMember, 'variable'],
  [SymbolInformation_Kind.Variable, 'variable'],
  [SymbolInformation_Kind.Constant, 'variable'],
  [SymbolInformation_Kind.StaticVariable, 'variable'],
  [SymbolInformation_Kind.Field, 'variable'],
  [SymbolInformation_Kind.StaticField, 'variable'],
  [SymbolInformation_Kind.Property, 'variable'],
  [SymbolInformation_Kind.StaticProperty, 'variable'],
]);

export function degradeKindFromScip(kind: SymbolInformation_Kind): SymbolKind | null {
  return DEGRADE_KIND_FROM_SCIP.get(kind) ?? null;
}

// ---------------------------------------------------------------------------
// Moniker ⇄ id (design §4.2)
//
// librarian-go . . . `store/memstore.go`/MemStore#Complete().
// ^scheme      ^empty package (repo-unaware invariant: no repo in monikers)
//              ^file as namespace descriptor, then container chain, then self.
//
// The id material is file::container::name::kind, so ingest ignores
// descriptor suffixes and only reconstructs the three name parts. Joining
// the middle descriptors with '.' reproduces SymbolRow.container exactly
// because that string was built by '.'-joining in the first place —
// segment boundaries may differ for dotted names, the joined string cannot.
// ---------------------------------------------------------------------------

export type LibrarianScheme =
  | 'librarian-ts'
  | 'librarian-go'
  | 'librarian-php'
  | 'librarian-py'
  | 'librarian-terraform';

export interface MonikerParts {
  file: string;
  /** dotted chain exactly as stored in SymbolRow.container */
  container: string | null;
  name: string;
  kind: SymbolKind;
  /**
   * Kind of each container.split('.') segment (outermost first), used only
   * for descriptor-suffix fidelity in the base layer. Missing entries fall
   * back to a type suffix ('#'); the id never depends on suffixes.
   */
  containerKinds?: SymbolKind[];
}

export type DescriptorSuffix =
  | 'namespace'
  | 'type'
  | 'term'
  | 'method'
  | 'meta'
  | 'macro'
  | 'typeParameter'
  | 'parameter';

export interface ParsedDescriptor {
  name: string;
  suffix: DescriptorSuffix;
  disambiguator?: string;
}

export interface ParsedMoniker {
  scheme: string;
  manager: string;
  packageName: string;
  version: string;
  descriptors: ParsedDescriptor[];
}

/** The (file, container, name) key a moniker denotes — the id material minus kind. */
export interface LibrarianSymbolKey {
  file: string;
  container: string | null;
  name: string;
}

const IDENT_CHAR = /[A-Za-z0-9_+$-]/;
const SIMPLE_IDENT = /^[A-Za-z0-9_+$-]+$/;
const TYPE_KINDS = new Set<SymbolKind>(['class', 'struct', 'interface', 'trait', 'enum']);

function escapeIdent(name: string): string {
  if (name === '') throw new Error('empty identifier cannot appear in a SCIP symbol');
  return SIMPLE_IDENT.test(name) ? name : '`' + name.replaceAll('`', '``') + '`';
}

function descriptorFor(name: string, kind: SymbolKind): string {
  if (kind === 'function' || kind === 'method') return `${escapeIdent(name)}().`;
  if (TYPE_KINDS.has(kind)) return `${escapeIdent(name)}#`;
  // variable, typealias — and the fallback for container segments of unknown kind
  return `${escapeIdent(name)}.`;
}

export function formatLocal(n: number): string {
  if (!Number.isInteger(n) || n < 0) throw new Error(`local id must be a non-negative integer, got ${n}`);
  return `local ${n}`;
}

export function isLocalSymbol(symbol: string): boolean {
  return symbol.startsWith('local ');
}

export function formatMoniker(scheme: LibrarianScheme, parts: MonikerParts): string {
  if (parts.kind === 'testblock') {
    throw new Error('testblocks are document-local symbols — use formatLocal(), not a moniker');
  }
  const head = `${scheme} . . . `;
  const fileDescriptor = `${escapeIdent(parts.file)}/`;
  if (parts.kind === 'module' && parts.name === parts.file && parts.container === null) {
    // The file-level module symbol: every extractor computes its id as
    // symbolId(file, null, file, 'module'), so the file descriptor alone must
    // recover it. A Terraform `module` block (kind module, name !== file)
    // falls through to a normal term descriptor below (#9), the same shape the
    // tf-extractor emits — recovered as name/container by monikerToParts, with
    // the kind coming back from SymbolInformation.kind (File → module).
    return head + fileDescriptor;
  }
  const segments = parts.container === null ? [] : parts.container.split('.');
  const segmentKinds = parts.containerKinds ?? [];
  const middle = segments.map((s, i) => descriptorFor(s, segmentKinds[i] ?? 'class')).join('');
  return head + fileDescriptor + middle + descriptorFor(parts.name, parts.kind);
}

/** Read one space-terminated header field; '  ' (double space) is a literal space. */
function readHeaderField(s: string, i: number, what: string): [string, number] {
  let out = '';
  while (i < s.length) {
    if (s[i] === ' ') {
      if (s[i + 1] === ' ') {
        out += ' ';
        i += 2;
        continue;
      }
      return [out, i + 1];
    }
    out += s[i++];
  }
  throw new Error(`truncated symbol: missing separator after ${what}`);
}

function readIdent(s: string, i: number): [string, number] {
  if (s[i] === '`') {
    i++;
    let out = '';
    while (i < s.length) {
      if (s[i] === '`') {
        if (s[i + 1] === '`') {
          out += '`';
          i += 2;
          continue;
        }
        return [out, i + 1];
      }
      out += s[i++];
    }
    throw new Error('unterminated escaped identifier');
  }
  let out = '';
  while (i < s.length && IDENT_CHAR.test(s[i])) out += s[i++];
  if (out === '') throw new Error(`expected identifier at position ${i}`);
  return [out, i];
}

export function parseMoniker(moniker: string): ParsedMoniker {
  if (isLocalSymbol(moniker)) {
    throw new Error(`local symbols have no package or descriptors: ${moniker}`);
  }
  let i = 0;
  const [scheme, i1] = readHeaderField(moniker, i, 'scheme');
  const [manager, i2] = readHeaderField(moniker, i1, 'manager');
  const [packageName, i3] = readHeaderField(moniker, i2, 'package name');
  const [version, i4] = readHeaderField(moniker, i3, 'version');
  if (scheme === '') throw new Error('scheme must not be empty');
  i = i4;

  const descriptors: ParsedDescriptor[] = [];
  while (i < moniker.length) {
    if (moniker[i] === '(') {
      const [name, j] = readIdent(moniker, i + 1);
      if (moniker[j] !== ')') throw new Error(`unterminated parameter descriptor at ${i}`);
      descriptors.push({ name, suffix: 'parameter' });
      i = j + 1;
      continue;
    }
    if (moniker[i] === '[') {
      const [name, j] = readIdent(moniker, i + 1);
      if (moniker[j] !== ']') throw new Error(`unterminated type-parameter descriptor at ${i}`);
      descriptors.push({ name, suffix: 'typeParameter' });
      i = j + 1;
      continue;
    }
    const [name, j] = readIdent(moniker, i);
    i = j;
    const c = moniker[i];
    if (c === undefined) throw new Error(`descriptor '${name}' missing suffix at end of symbol`);
    i++;
    switch (c) {
      case '/':
        descriptors.push({ name, suffix: 'namespace' });
        break;
      case '#':
        descriptors.push({ name, suffix: 'type' });
        break;
      case '.':
        descriptors.push({ name, suffix: 'term' });
        break;
      case ':':
        descriptors.push({ name, suffix: 'meta' });
        break;
      case '!':
        descriptors.push({ name, suffix: 'macro' });
        break;
      case '(': {
        let disambiguator: string | undefined;
        if (moniker[i] !== ')') {
          const [d, k] = readIdent(moniker, i);
          disambiguator = d;
          i = k;
        }
        if (moniker[i] !== ')') throw new Error(`unterminated method descriptor for '${name}'`);
        i++;
        if (moniker[i] !== '.') throw new Error(`method descriptor '${name}' missing trailing '.'`);
        i++;
        descriptors.push(
          disambiguator === undefined
            ? { name, suffix: 'method' }
            : { name, suffix: 'method', disambiguator },
        );
        break;
      }
      default:
        throw new Error(`unexpected character '${c}' after descriptor '${name}'`);
    }
  }
  if (descriptors.length === 0) throw new Error(`symbol has no descriptors: ${moniker}`);
  return { scheme, manager, packageName, version, descriptors };
}

/**
 * Interpret a file-rooted moniker (first descriptor = file namespace, the
 * librarian emit shape) as the id key. External monikers that are not
 * file-rooted (e.g. package-rooted scip-typescript symbols) are a Step-4
 * concern — their key comes from Document context, not from this function.
 */
export function monikerToParts(moniker: string): LibrarianSymbolKey {
  const parsed = parseMoniker(moniker);
  const [fileDescriptor, ...rest] = parsed.descriptors;
  if (fileDescriptor.suffix !== 'namespace') {
    throw new Error(`not a file-rooted moniker (first descriptor must be a namespace): ${moniker}`);
  }
  const file = fileDescriptor.name;
  if (rest.length === 0) return { file, container: null, name: file }; // module: name === file
  const name = rest[rest.length - 1].name;
  const middle = rest.slice(0, -1).map((d) => d.name);
  return { file, container: middle.length > 0 ? middle.join('.') : null, name };
}

export function monikerToId(moniker: string, kind: SymbolKind): string {
  const key = monikerToParts(moniker);
  return symbolId(key.file, key.container, key.name, kind);
}

/**
 * Best-effort classification of an EXTERNAL moniker (degrade ingest, design
 * §4.5): the descriptors after the last namespace descriptor are the symbol —
 * package/module path is not a librarian container, and the file comes from
 * the Document, not the moniker.
 *
 * - `module`: nothing name-like after the namespace path, or the scip-python
 *   convention of a trailing `__init__:` meta descriptor. The ingest aliases
 *   these to its synthesized per-document module row.
 * - `parameter`: terminal (type-)parameter descriptor — not a symbol at all.
 * - `named`: a symbol; `suffix` lets the ingest derive a kind when the
 *   producer left SymbolInformation.kind unset (scip-python 0.6.x does).
 */
export type ExternalMonikerKey =
  | { kind: 'named'; name: string; container: string | null; suffix: DescriptorSuffix }
  | { kind: 'module' }
  | { kind: 'parameter' }
  | { kind: 'invalid' };

export function externalMonikerKey(moniker: string): ExternalMonikerKey {
  let parsed: ParsedMoniker;
  try {
    parsed = parseMoniker(moniker);
  } catch {
    return { kind: 'invalid' };
  }
  let start = 0;
  for (let i = 0; i < parsed.descriptors.length; i++) {
    if (parsed.descriptors[i].suffix === 'namespace') start = i + 1;
  }
  const chain = parsed.descriptors.slice(start);
  if (chain.length === 0) return { kind: 'module' };
  const last = chain[chain.length - 1];
  if (last.suffix === 'parameter' || last.suffix === 'typeParameter') return { kind: 'parameter' };
  if (last.suffix === 'meta' && last.name === '__init__') return { kind: 'module' };
  const middle = chain.slice(0, -1).map((d) => d.name);
  return {
    kind: 'named',
    name: last.name,
    container: middle.length > 0 ? middle.join('.') : null,
    suffix: last.suffix,
  };
}

// ---------------------------------------------------------------------------
// Range conversion (design §4.3): SymbolRow spans are 1-based inclusive line
// numbers; SCIP ranges are 0-based half-open with character columns.
// ---------------------------------------------------------------------------

export interface ScipMultiLineRange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

export interface ScipSingleLineRange {
  line: number;
  startCharacter: number;
  endCharacter: number;
}

/** Whole-lines enclosing range for a span: [ (start-1, 0), (end, 0) ). */
export function spanToScipRange(spanStart: number, spanEnd: number): ScipMultiLineRange {
  if (!Number.isInteger(spanStart) || !Number.isInteger(spanEnd) || spanStart < 1 || spanEnd < spanStart) {
    throw new Error(`invalid line span ${spanStart}-${spanEnd}`);
  }
  return { startLine: spanStart - 1, startCharacter: 0, endLine: spanEnd, endCharacter: 0 };
}

export function scipRangeToSpan(
  range: ScipMultiLineRange | ScipSingleLineRange,
): { spanStart: number; spanEnd: number } {
  if ('line' in range) {
    return { spanStart: range.line + 1, spanEnd: range.line + 1 };
  }
  const spanStart = range.startLine + 1;
  // Half-open: an end at column 0 of endLine excludes endLine itself.
  const spanEnd =
    range.endCharacter === 0 && range.endLine > range.startLine ? range.endLine : range.endLine + 1;
  return { spanStart, spanEnd: Math.max(spanEnd, spanStart) };
}
