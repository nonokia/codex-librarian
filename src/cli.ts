/**
 * CLI — every capability exists here first (architecture §4-④).
 * JSON out by default (agent-first consumers), `--pretty` for humans.
 */
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { Store, type NeighborRow, type SymbolRow } from './store.js';
import { indexRepo } from './indexer.js';

interface Flags {
  db?: string;
  hops: number;
  pretty: boolean;
  limit: number;
}

function parseArgs(argv: string[]): { command: string; positional: string[]; flags: Flags } {
  const flags: Flags = { hops: 2, pretty: false, limit: 20 };
  const positional: string[] = [];
  let command = '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') flags.db = argv[++i];
    else if (a === '--hops') flags.hops = Number(argv[++i]);
    else if (a === '--limit') flags.limit = Number(argv[++i]);
    else if (a === '--pretty') flags.pretty = true;
    else if (!command) command = a;
    else positional.push(a);
  }
  return { command, positional, flags };
}

function defaultDb(repoRoot?: string): string {
  const base = repoRoot ?? process.cwd();
  return join(base, '.librarian', 'index.db');
}

function emit(value: unknown, pretty: boolean): void {
  console.log(JSON.stringify(value, null, pretty ? 2 : undefined));
}

function fail(message: string): never {
  console.error(JSON.stringify({ error: { message } }));
  process.exit(1);
}

const HELP = `codex-librarian — graph-first code knowledge store (docs/architecture.md)

Usage:
  librarian index <repo> [--db <file>]        Index a repository (incremental)
  librarian stats [--db <file>]               Store statistics
  librarian symbols <query> [--limit N]       Find symbols by (partial) name
  librarian file <path>                       Symbols declared in a file
  librarian graph <symbol> [--hops N]         k-hop neighborhood of a symbol
  librarian help                              This help

Common flags: --db <file> (default: <repo>/.librarian/index.db of the current
directory), --pretty (indented JSON).`;

function openStore(flags: Flags): Store {
  const path = flags.db ?? defaultDb();
  if (!existsSync(path)) fail(`no index at ${path} — run \`librarian index <repo>\` first (or pass --db)`);
  return new Store(path);
}

function compactSymbol(s: SymbolRow) {
  return {
    id: s.id,
    kind: s.kind,
    name: s.container ? `${s.container}.${s.name}` : s.name,
    file: s.file,
    span: [s.spanStart, s.spanEnd],
    signature: s.signature ?? undefined,
  };
}

function main(): void {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));

  switch (command) {
    case 'index': {
      const root = resolve(positional[0] ?? '.');
      if (!existsSync(root)) fail(`no such directory: ${root}`);
      const store = new Store(flags.db ?? defaultDb(root));
      const report = indexRepo(store, root);
      store.close();
      emit(report, flags.pretty);
      break;
    }
    case 'stats': {
      const store = openStore(flags);
      emit({ ...store.stats(), root: store.getMeta('root') }, flags.pretty);
      store.close();
      break;
    }
    case 'symbols': {
      if (!positional[0]) fail('usage: librarian symbols <query>');
      const store = openStore(flags);
      emit(store.findSymbols(positional[0], flags.limit).map(compactSymbol), flags.pretty);
      store.close();
      break;
    }
    case 'file': {
      if (!positional[0]) fail('usage: librarian file <path>');
      const store = openStore(flags);
      emit(store.symbolsInFile(positional[0]).map(compactSymbol), flags.pretty);
      store.close();
      break;
    }
    case 'graph': {
      if (!positional[0]) fail('usage: librarian graph <symbol> [--hops N]');
      const store = openStore(flags);
      const matches = store.findSymbols(positional[0], 2);
      if (matches.length === 0) {
        store.close();
        fail(`no symbol matching "${positional[0]}"`);
      }
      const seed = matches[0];
      const neighbors = store.neighborhood(seed.id, flags.hops, flags.limit * 10);
      const edges = store.edgesOf(seed.id);
      emit(
        {
          seed: compactSymbol(seed),
          ambiguous: matches.length > 1 ? matches.slice(1).map(compactSymbol) : undefined,
          hops: flags.hops,
          neighbors: neighbors.map((n: NeighborRow) => ({
            ...compactSymbol(n),
            depth: n.depth,
            via: `${n.direction === 'out' ? '→' : '←'} ${n.edgeKind}`,
          })),
          unresolvedOut: edges.out.filter((e) => !e.resolved).map((e) => `${e.kind} ${e.toName}`),
        },
        flags.pretty
      );
      store.close();
      break;
    }
    case 'help':
    case '':
    case '--help':
      console.log(HELP);
      break;
    default:
      fail(`unknown command: ${command} (try \`librarian help\`)`);
  }
}

main();
