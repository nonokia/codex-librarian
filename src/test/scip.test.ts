import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SymbolInformation_Kind, SymbolRole } from '@scip-code/scip';
import { symbolId } from '../protocol/extractor.js';
import type { SymbolKind } from '../store/store.js';
import {
  KIND_TO_SCIP,
  createScipIndex,
  decodeScip,
  encodeScip,
  formatLocal,
  formatMoniker,
  isLocalSymbol,
  kindFromScip,
  monikerToId,
  monikerToParts,
  parseCapabilities,
  parseMoniker,
  parseScipPlus,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  scipFromJson,
  scipRangeToSpan,
  scipToJson,
  spanToScipRange,
} from '../protocol/scip.js';

// --- moniker: format ---------------------------------------------------------

test('moniker format matches the documented shape (design §4.2)', () => {
  const m = formatMoniker('librarian-go', {
    file: 'store/memstore.go',
    container: 'MemStore',
    name: 'Complete',
    kind: 'method',
    containerKinds: ['struct'],
  });
  assert.equal(m, 'librarian-go . . . `store/memstore.go`/MemStore#Complete().');
});

test('module moniker is the file descriptor alone', () => {
  const m = formatMoniker('librarian-ts', {
    file: 'src/store.ts',
    container: null,
    name: 'src/store.ts',
    kind: 'module',
  });
  assert.equal(m, 'librarian-ts . . . `src/store.ts`/');
});

test('module moniker rejects name !== file (id would be unrecoverable)', () => {
  assert.throws(
    () =>
      formatMoniker('librarian-ts', { file: 'a.ts', container: null, name: 'b', kind: 'module' }),
    /name === file/,
  );
});

test('testblocks are refused a moniker — they are local symbols', () => {
  assert.throws(
    () =>
      formatMoniker('librarian-ts', {
        file: 'a.test.ts',
        container: null,
        name: 'renders',
        kind: 'testblock',
      }),
    /formatLocal/,
  );
  assert.equal(formatLocal(3), 'local 3');
  assert.ok(isLocalSymbol('local 3'));
  assert.ok(!isLocalSymbol('librarian-ts . . . `a.ts`/x.'));
});

// --- moniker: roundtrip & id equality ---------------------------------------

interface Case {
  file: string;
  container: string | null;
  name: string;
  kind: SymbolKind;
  containerKinds?: SymbolKind[];
}

const CASES: Case[] = [
  { file: 'src/store.ts', container: null, name: 'src/store.ts', kind: 'module' },
  { file: 'src/store.ts', container: null, name: 'rowToSymbol', kind: 'function' },
  { file: 'src/store.ts', container: 'Store', name: 'replaceFile', kind: 'method', containerKinds: ['class'] },
  { file: 'store/task.go', container: 'Task', name: 'Overdue', kind: 'method', containerKinds: ['struct'] },
  { file: 'src/a.ts', container: 'Outer.Inner', name: 'value', kind: 'variable', containerKinds: ['class', 'class'] },
  // container segment that is a testblock name containing dots and spaces:
  // split/join must reproduce the exact container string for the id
  { file: 'src/x.test.ts', container: 'MemStore.complete works', name: 'helper', kind: 'function' },
  { file: 'app/Service.php', container: 'App\\TaskService', name: 'create', kind: 'method', containerKinds: ['class'] },
  { file: 'src/util.ts', container: null, name: 'weird `name` +x', kind: 'variable' },
];

test('moniker roundtrip recovers file/container/name exactly', () => {
  for (const c of CASES) {
    const m = formatMoniker('librarian-ts', c);
    const key = monikerToParts(m);
    assert.equal(key.file, c.file, m);
    assert.equal(key.name, c.kind === 'module' ? c.file : c.name, m);
    assert.equal(key.container, c.container, m);
  }
});

test('monikerToId equals the extractor id scheme byte-for-byte', () => {
  for (const c of CASES) {
    const m = formatMoniker('librarian-go', c);
    assert.equal(monikerToId(m, c.kind), symbolId(c.file, c.container, c.name, c.kind), m);
  }
});

// --- moniker: grammar --------------------------------------------------------

test('parseMoniker handles an external scip-typescript-shaped symbol', () => {
  const p = parseMoniker('scip-typescript npm @scope/pkg 1.2.3 `src/x.ts`/Class#method().');
  assert.equal(p.scheme, 'scip-typescript');
  assert.equal(p.manager, 'npm');
  assert.equal(p.packageName, '@scope/pkg');
  assert.equal(p.version, '1.2.3');
  assert.deepEqual(p.descriptors, [
    { name: 'src/x.ts', suffix: 'namespace' },
    { name: 'Class', suffix: 'type' },
    { name: 'method', suffix: 'method' },
  ]);
});

test('parseMoniker honours double-space escapes in header fields', () => {
  const p = parseMoniker('librarian-ts a  b . . `f.ts`/');
  assert.equal(p.manager, 'a b');
  assert.equal(p.packageName, '.');
  assert.equal(p.version, '.');
});

test('parseMoniker reads method disambiguators and exotic descriptors', () => {
  const p = parseMoniker('s . . . ns/T#m(overload1).[P](x)meta:mac!');
  assert.deepEqual(
    p.descriptors.map((d) => d.suffix),
    ['namespace', 'type', 'method', 'typeParameter', 'parameter', 'meta', 'macro'],
  );
  assert.equal(p.descriptors[2].disambiguator, 'overload1');
});

test('parseMoniker rejects malformed symbols', () => {
  assert.throws(() => parseMoniker('local 3'), /local symbols/);
  assert.throws(() => parseMoniker('s . . .'), /separator|descriptor/);
  assert.throws(() => parseMoniker('s . . . `unterminated'), /unterminated/);
  assert.throws(() => parseMoniker('s . . . name'), /missing suffix/);
  assert.throws(() => parseMoniker('s . . . m(x.'), /unterminated method|method descriptor/);
});

test('monikerToParts rejects non-file-rooted monikers', () => {
  assert.throws(() => monikerToParts('s . . . Class#m().'), /file-rooted/);
});

// --- kind mapping -------------------------------------------------------------

test('kind mapping is a bijection on the mapped subset; testblock excluded', () => {
  for (const [k, v] of Object.entries(KIND_TO_SCIP)) {
    assert.equal(kindFromScip(v), k);
  }
  assert.equal(kindFromScip(SymbolInformation_Kind.Contract), null);
  assert.ok(!('testblock' in KIND_TO_SCIP));
});

// --- range conversion ----------------------------------------------------------

test('span → range → span roundtrips', () => {
  for (const [s, e] of [
    [1, 1],
    [5, 5],
    [3, 7],
    [1, 400],
  ]) {
    const r = spanToScipRange(s, e);
    assert.deepEqual(scipRangeToSpan(r), { spanStart: s, spanEnd: e }, `${s}-${e}`);
  }
});

test('range → span handles single-line and mid-line ends', () => {
  assert.deepEqual(scipRangeToSpan({ line: 4, startCharacter: 2, endCharacter: 9 }), {
    spanStart: 5,
    spanEnd: 5,
  });
  // end falls mid-line → that line is part of the span
  assert.deepEqual(
    scipRangeToSpan({ startLine: 2, startCharacter: 0, endLine: 6, endCharacter: 12 }),
    { spanStart: 3, spanEnd: 7 },
  );
  // empty range on one line
  assert.deepEqual(
    scipRangeToSpan({ startLine: 2, startCharacter: 0, endLine: 2, endCharacter: 0 }),
    { spanStart: 3, spanEnd: 3 },
  );
});

test('spanToScipRange rejects invalid spans', () => {
  assert.throws(() => spanToScipRange(0, 1), /invalid line span/);
  assert.throws(() => spanToScipRange(5, 4), /invalid line span/);
});

// --- protobuf boundary ----------------------------------------------------------

function sampleIndex() {
  return createScipIndex({
    metadata: {
      toolInfo: { name: 'librarian-go', version: '0.1.0' },
      projectRoot: 'file:///repo',
    },
    documents: [
      {
        relativePath: 'store/memstore.go',
        language: 'go',
        occurrences: [
          {
            typedRange: {
              case: 'multiLineRange',
              value: { startLine: 9, startCharacter: 0, endLine: 42, endCharacter: 0 },
            },
            symbol: 'librarian-go . . . `store/memstore.go`/MemStore#Complete().',
            symbolRoles: SymbolRole.Definition,
          },
        ],
        symbols: [
          {
            symbol: 'librarian-go . . . `store/memstore.go`/MemStore#Complete().',
            kind: SymbolInformation_Kind.Method,
            displayName: 'Complete',
          },
        ],
      },
    ],
  });
}

test('.scip binary roundtrips through encode/decode', () => {
  const index = sampleIndex();
  const decoded = decodeScip(encodeScip(index));
  assert.deepEqual(scipToJson(decoded), scipToJson(index));
});

test('proto3 canonical JSON roundtrips (the child-process representation)', () => {
  const index = sampleIndex();
  const viaJson = scipFromJson(JSON.parse(JSON.stringify(scipToJson(index))));
  assert.deepEqual(scipToJson(viaJson), scipToJson(index));
});

// --- envelope -------------------------------------------------------------------

function sampleEnvelope(): unknown {
  return JSON.parse(
    JSON.stringify({
      scip: scipToJson(sampleIndex()),
      ext: {
        version: 1,
        documents: [
          {
            relativePath: 'store/memstore.go',
            symbols: [
              {
                symbol: 'local 0',
                kind: 'testblock',
                name: 'TestMemStoreComplete',
                container: null,
                spanStart: 10,
                spanEnd: 42,
              },
            ],
            edges: [
              {
                from: 'librarian-go . . . `store/memstore.go`/MemStore#Complete().',
                to: null,
                toName: 'helperFn',
                kind: 'references',
                resolved: false,
              },
            ],
          },
        ],
      },
    }),
  );
}

test('parseScipPlus accepts a well-formed envelope', () => {
  const { index, ext } = parseScipPlus(sampleEnvelope());
  assert.equal(index.documents[0].relativePath, 'store/memstore.go');
  assert.equal(ext.documents[0].edges[0].resolved, false);
  assert.equal(ext.documents[0].symbols[0].kind, 'testblock');
});

test('parseScipPlus rejects malformed envelopes with precise errors', () => {
  assert.throws(() => parseScipPlus(null), /JSON object/);
  assert.throws(() => parseScipPlus({ scip: {} }), /requires both/);

  const badVersion = sampleEnvelope() as { ext: { version: number } };
  badVersion.ext.version = 2;
  assert.throws(() => parseScipPlus(badVersion), /unsupported ext version 2/);

  const badKind = sampleEnvelope() as {
    ext: { documents: { edges: { kind: string }[] }[] };
  };
  badKind.ext.documents[0].edges[0].kind = 'callz';
  assert.throws(() => parseScipPlus(badKind), /edges\[0\].kind "callz"/);

  const badSpan = sampleEnvelope() as {
    ext: { documents: { symbols: { spanStart: unknown }[] }[] };
  };
  badSpan.ext.documents[0].symbols[0].spanStart = '10';
  assert.throws(() => parseScipPlus(badSpan), /spanStart\/spanEnd must be integers/);
});

// --- capabilities handshake (issue #22 / ADR-7) ------------------------------

test('parseCapabilities accepts a well-formed handshake reply', () => {
  const caps = parseCapabilities({
    protocol: PROTOCOL_NAME,
    protocolVersion: PROTOCOL_VERSION,
    name: 'librarian-go',
    extensions: ['.go'],
  });
  assert.equal(caps.name, 'librarian-go');
  assert.deepEqual(caps.extensions, ['.go']);
});

test('parseCapabilities rejects malformed replies with precise errors', () => {
  assert.throws(() => parseCapabilities(null), /JSON object/);
  assert.throws(() => parseCapabilities([]), /JSON object/);
  assert.throws(
    () => parseCapabilities({ protocol: 'other', protocolVersion: 1, name: 'x', extensions: [] }),
    /protocol .* is not/
  );
  assert.throws(
    () => parseCapabilities({ protocol: PROTOCOL_NAME, protocolVersion: '1', name: 'x', extensions: [] }),
    /protocolVersion must be an integer/
  );
  assert.throws(
    () => parseCapabilities({ protocol: PROTOCOL_NAME, protocolVersion: 1, name: '', extensions: [] }),
    /name must be a non-empty string/
  );
  assert.throws(
    () => parseCapabilities({ protocol: PROTOCOL_NAME, protocolVersion: 1, name: 'x', extensions: ['.go', 1] }),
    /extensions must be an array of strings/
  );
  // A well-formed reply announcing an unknown major still parses (negotiation is the runner's call).
  const future = parseCapabilities({ protocol: PROTOCOL_NAME, protocolVersion: 99, name: 'x', extensions: ['.x'] });
  assert.equal(future.protocolVersion, 99);
});
