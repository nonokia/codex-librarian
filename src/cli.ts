/**
 * CLI — every capability exists here first (architecture §4-④).
 * JSON out by default (agent-first consumers), `--pretty` for humans.
 */
import { resolve, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { Store, type NeighborRow, type SymbolRow } from './store.js';
import { indexRepo } from './indexer.js';
import { parseUnifiedDiff } from './diff.js';
import { retrieveForDiff, DEFAULT_BUDGET } from './retrieval.js';
import { loadGoldenFile, runEval } from './eval.js';
import { assembleReviewPack, renderReviewPack } from './contextpack.js';
import { generateReview, buildReviewRequest, renderReviewMarkdown, DEFAULT_MODEL } from './review.js';
import { learn, recordReviewOutcome } from './loop.js';
import { buildMap, renderMapMarkdown } from './map.js';

interface Flags {
  db?: string;
  repo?: string;
  model: string;
  hops?: number;
  budget: number;
  pretty: boolean;
  source: boolean;
  dryRun: boolean;
  markdown: boolean;
  useCache?: boolean;
  holdout: boolean;
  note?: string;
  good: boolean;
  bad: boolean;
  limit: number;
  include: string[];
  json: boolean;
}

function parseArgs(argv: string[]): { command: string; positional: string[]; flags: Flags } {
  const flags: Flags = {
    model: process.env.LIBRARIAN_MODEL ?? DEFAULT_MODEL,
    budget: DEFAULT_BUDGET,
    pretty: false,
    source: false,
    dryRun: false,
    markdown: false,
    holdout: false,
    good: false,
    bad: false,
    limit: 20,
    include: [],
    json: false,
  };
  const positional: string[] = [];
  let command = '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') flags.db = argv[++i];
    else if (a === '--repo') flags.repo = argv[++i];
    else if (a === '--hops') flags.hops = Number(argv[++i]);
    else if (a === '--budget') flags.budget = Number(argv[++i]);
    else if (a === '--limit') flags.limit = Number(argv[++i]);
    else if (a === '--include') flags.include.push(argv[++i]);
    else if (a === '--json') flags.json = true;
    else if (a === '--source') flags.source = true;
    else if (a === '--model') flags.model = argv[++i];
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--markdown') flags.markdown = true;
    else if (a === '--use-cache') flags.useCache = true;
    else if (a === '--no-cache') flags.useCache = false;
    else if (a === '--holdout') flags.holdout = true;
    else if (a === '--note') flags.note = argv[++i];
    else if (a === '--good') flags.good = true;
    else if (a === '--bad') flags.bad = true;
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
  librarian index <repo> [--db <file>] [--include <prefix>]...
                                              Index a repository (incremental);
                                              --include restricts to path prefixes
  librarian stats [--db <file>]               Store statistics
  librarian map [--json] [--db <file>]        Deterministic codebase map (markdown)
  librarian symbols <query> [--limit N]       Find symbols by (partial) name
  librarian file <path>                       Symbols declared in a file
  librarian graph <symbol> [--hops N]         k-hop neighborhood of a symbol
  librarian retrieve <diff-file|-> [--budget N] [--source]
                                              Context pack for a unified diff
  librarian eval <golden.json> [--budget N]   Retrieval match rate vs golden set
  librarian pack <diff-file|->                Sectioned Context Pack (markdown)
  librarian review <diff-file|-> [--model M] [--dry-run] [--markdown]
                                              LLM review grounded in the pack
  librarian learn <golden.json> [--holdout]   Sweep strategies per diff signature,
                                              promote winners into PatternCache
  librarian patterns                          Show the PatternCache
  librarian history                           Eval results over time (ADR-4 series)
  librarian log [--limit N]                   Recent retrieval-log entries
  librarian feedback <log-id> --good|--bad    Human 👍/👎 on a retrieval
  librarian help                              This help

pack/review apply cached strategies by default (--no-cache to disable);
eval stays on the default strategy unless --use-cache is passed.

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
      const report = indexRepo(store, root, { include: flags.include });
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
    case 'map': {
      const store = openStore(flags);
      const map = buildMap(store);
      store.close();
      // markdown is the committed grep-able artifact; --json for programmatic use
      if (flags.json) emit(map, flags.pretty);
      else console.log(renderMapMarkdown(map));
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
      const neighbors = store.neighborhood(seed.id, flags.hops ?? 2, flags.limit * 10);
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
    case 'retrieve': {
      if (!positional[0]) fail('usage: librarian retrieve <diff-file|-> [--budget N]');
      const diffText =
        positional[0] === '-' ? readFileSync(0, 'utf8') : readFileSync(positional[0], 'utf8');
      const store = openStore(flags);
      const root = flags.repo ?? store.getMeta('root');
      if (!root) fail('index has no recorded root — pass --repo <dir>');
      const pack = retrieveForDiff(store, root, parseUnifiedDiff(diffText), {
        hops: flags.hops,
        budget: flags.budget,
        withSource: flags.source,
      });
      emit(pack, flags.pretty);
      store.close();
      break;
    }
    case 'eval': {
      if (!positional[0]) fail('usage: librarian eval <golden.json> [--budget N] [--use-cache]');
      const store = openStore(flags);
      const root = flags.repo ?? store.getMeta('root');
      if (!root) fail('index has no recorded root — pass --repo <dir>');
      const report = runEval(store, root, loadGoldenFile(positional[0]), {
        hops: flags.hops,
        budget: flags.budget,
        useCache: flags.useCache ?? false,
      });
      store.recordEval({
        golden: positional[0],
        cases: report.aggregate.cases,
        microRecall: report.aggregate.microRecall,
        macroRecall: report.aggregate.macroRecall,
        perfect: report.aggregate.perfectCases,
        budget: flags.budget,
        hops: flags.hops ?? 0,
        usedCache: flags.useCache ?? false,
        note: flags.note,
      });
      emit(report, flags.pretty);
      store.close();
      break;
    }
    case 'learn': {
      if (!positional[0]) fail('usage: librarian learn <golden.json> [--holdout]');
      const store = openStore(flags);
      const root = flags.repo ?? store.getMeta('root');
      if (!root) fail('index has no recorded root — pass --repo <dir>');
      const report = learn(store, root, loadGoldenFile(positional[0]), {
        budget: flags.budget,
        holdout: flags.holdout,
      });
      emit(report, flags.pretty);
      store.close();
      break;
    }
    case 'patterns': {
      const store = openStore(flags);
      emit(store.listPatterns(), flags.pretty);
      store.close();
      break;
    }
    case 'history': {
      const store = openStore(flags);
      emit(store.evalHistory(), flags.pretty);
      store.close();
      break;
    }
    case 'log': {
      const store = openStore(flags);
      emit(store.listRetrievals(flags.limit), flags.pretty);
      store.close();
      break;
    }
    case 'feedback': {
      if (!positional[0] || flags.good === flags.bad) {
        fail('usage: librarian feedback <log-id> (--good | --bad)');
      }
      const store = openStore(flags);
      const ok = store.updateRetrievalOutcome(Number(positional[0]), {
        feedback: flags.good ? 1 : -1,
      });
      store.close();
      if (!ok) fail(`no retrieval log entry with id ${positional[0]}`);
      emit({ id: Number(positional[0]), feedback: flags.good ? 1 : -1 }, flags.pretty);
      break;
    }
    case 'pack':
    case 'review': {
      if (!positional[0]) fail(`usage: librarian ${command} <diff-file|->`);
      const diffText =
        positional[0] === '-' ? readFileSync(0, 'utf8') : readFileSync(positional[0], 'utf8');
      const store = openStore(flags);
      const root = flags.repo ?? store.getMeta('root');
      if (!root) fail('index has no recorded root — pass --repo <dir>');
      const t0 = Date.now();
      const retrieved = retrieveForDiff(store, root, parseUnifiedDiff(diffText), {
        hops: flags.hops,
        budget: flags.budget,
        withSource: true,
        useCache: flags.useCache ?? true, // learned strategies apply by default here
      });
      const logId = store.logRetrieval({
        source: command,
        signature: retrieved.signature,
        strategy: JSON.stringify(retrieved.strategy),
        fromCache: retrieved.strategyFromCache,
        seeds: retrieved.seeds.map((s) => s.name),
        itemCount: retrieved.items.length,
        elidedCount: retrieved.elided.length,
        usedChars: retrieved.usedChars,
        latencyMs: Date.now() - t0,
      });
      const pack = assembleReviewPack(diffText, retrieved);

      if (command === 'pack') {
        store.close();
        console.log(renderReviewPack(pack));
        break;
      }
      if (flags.dryRun) {
        store.close();
        const request = buildReviewRequest(pack, flags.model);
        emit(
          {
            dry_run: true,
            model: request.model,
            retrieval_log_id: logId,
            strategy_from_cache: retrieved.strategyFromCache,
            system_chars: request.system.length,
            prompt_chars: request.messages[0].content.length,
            prompt: request.messages[0].content,
          },
          flags.pretty
        );
        break;
      }
      generateReview(pack, { model: flags.model })
        .then((result) => {
          // feedback signal (a): write which sections the findings cited
          recordReviewOutcome(store, logId, result);
          store.close();
          if (flags.markdown) console.log(renderReviewMarkdown(result));
          else emit({ retrieval_log_id: logId, ...result }, flags.pretty);
        })
        .catch((err: Error) => {
          store.close();
          fail(`review failed: ${err.message}`);
        });
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
