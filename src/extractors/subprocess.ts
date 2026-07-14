/**
 * SubprocessExtractor — the generic subprocess plugin runner (issue #22 /
 * ADR-7). It replaces the near-identical plumbing that used to live once per
 * language (extractor-go.ts / extractor-php.ts): resolve a command, feed
 * `{root, files}` JSON on stdin, ingest the SCIP+ envelope the plugin prints on
 * stdout (design §4), and degrade to file-level module symbols when the plugin
 * is unavailable — the same "degrade, don't block" policy the rest of the
 * pipeline follows.
 *
 * The wire contract IS the SCIP+ envelope; this runner is its consumer. It
 * lives in extractors/ (client-side plumbing), while the contract itself
 * (envelope types, moniker ⇄ id, JSON Schema) stays in protocol/ — the future
 * npm-packaged public unit. A language leg (go.ts / php.ts) or a
 * `.librarian/extractors.json` entry is now just a name + extensions + a
 * command resolver handed to this class.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import type { ExtractionResult, Extractor } from '../protocol/extractor.js';
import {
  PROTOCOL_VERSION,
  parseCapabilities,
  parseScipPlus,
  type Capabilities,
} from '../protocol/scip.js';
import { scipPlusToExtractionResults } from '../protocol/scip-ingest.js';

const MAX_OUTPUT = 512 * 1024 * 1024;

/** A resolved plugin invocation: what to spawn and where. */
export interface SubprocessCommand {
  cmd: string;
  args: string[];
  /** working directory (e.g. the `go run .` source dir); undefined = inherit */
  cwd?: string;
}

export interface SubprocessExtractorConfig {
  /** moniker scheme / ToolInfo.name, e.g. 'librarian-go' */
  name: string;
  /** extensions this plugin claims, e.g. ['.go'] */
  extensions: string[];
  /** resolve the command to run, or null when the plugin is unavailable */
  resolveCommand: () => SubprocessCommand | null;
  /** stderr warning printed when resolveCommand returns null, before degrading */
  unavailableWarning: string;
}

export class SubprocessExtractor implements Extractor {
  readonly name: string;
  readonly extensions: string[];
  private readonly resolveCommand: () => SubprocessCommand | null;
  private readonly unavailableWarning: string;
  /** capabilities handshake is per-command; query once per process (design §6.2) */
  private negotiated = false;

  constructor(config: SubprocessExtractorConfig) {
    this.name = config.name;
    this.extensions = config.extensions;
    this.resolveCommand = config.resolveCommand;
    this.unavailableWarning = config.unavailableWarning;
  }

  extract(rootDir: string, files: string[]): ExtractionResult[] {
    const command = this.resolveCommand();
    if (!command) {
      console.error(this.unavailableWarning);
      return fileLevelOnly(rootDir, files);
    }
    this.negotiate(command);
    const res = spawnSync(command.cmd, command.args, {
      cwd: command.cwd,
      input: JSON.stringify({ root: rootDir, files }),
      encoding: 'utf8',
      maxBuffer: MAX_OUTPUT,
    });
    if (res.error) {
      throw new Error(`${this.name} extractor failed to spawn (${command.cmd}): ${res.error.message}`);
    }
    if (res.stderr) process.stderr.write(res.stderr);
    if (res.status !== 0) {
      throw new Error(`${this.name} extractor exited with ${res.status}`);
    }
    const payload: unknown = JSON.parse(res.stdout);
    if (Array.isArray(payload)) {
      throw new Error(
        `${this.name} extractor emitted the legacy ExtractionResult[] contract — the contract is now ` +
          'the SCIP+ envelope (issue #16). Rebuild/update the plugin to a current build.'
      );
    }
    const { index, ext } = parseScipPlus(payload);
    return scipPlusToExtractionResults(index, ext);
  }

  /**
   * Query `--capabilities` once and negotiate the envelope major (design §6.2).
   * A plugin that predates the handshake fails or mis-parses the flag; that is
   * not fatal — it is treated as protocolVersion 1 (backward compat). Only a
   * plugin that positively announces a major this runner cannot read stops the
   * run, so a version skew never degrades silently.
   */
  private negotiate(command: SubprocessCommand): void {
    if (this.negotiated) return;
    this.negotiated = true;
    const res = spawnSync(command.cmd, [...command.args, '--capabilities'], {
      cwd: command.cwd,
      input: '',
      encoding: 'utf8',
      maxBuffer: MAX_OUTPUT,
    });
    if (res.error || res.status !== 0) return; // pre-handshake plugin → assume v1
    let caps: Capabilities;
    try {
      caps = parseCapabilities(JSON.parse(res.stdout));
    } catch {
      return; // unparseable reply → assume v1
    }
    if (caps.protocolVersion > PROTOCOL_VERSION) {
      throw new Error(
        `${this.name} speaks SCIP+ protocol v${caps.protocolVersion}, but this librarian speaks ` +
          `v${PROTOCOL_VERSION}. Upgrade librarian or use a matching plugin build.`
      );
    }
    const claimed = new Set(this.extensions);
    const reported = new Set(caps.extensions);
    if (this.extensions.some((e) => !reported.has(e)) || caps.extensions.some((e) => !claimed.has(e))) {
      console.error(
        `warn: ${this.name} is registered for [${this.extensions.join(', ')}] but reports ` +
          `[${caps.extensions.join(', ')}]; routing uses the registration.`
      );
    }
  }
}

/**
 * File-level fallback rows for when no plugin is available — one module symbol
 * per claimed file, so the index degrades instead of failing. Shared by every
 * subprocess plugin (was duplicated in each language adapter).
 */
export function fileLevelOnly(rootDir: string, files: string[]): ExtractionResult[] {
  return files.map((abs) => {
    const file = relative(rootDir, abs).split(sep).join('/');
    let lines = 1;
    try {
      const text = readFileSync(abs, 'utf8');
      lines = Math.max(1, text.split('\n').length - (text.endsWith('\n') ? 1 : 0));
    } catch {
      /* unreadable file still gets a 1-line module row */
    }
    return {
      file,
      symbols: [
        {
          id: moduleId(file),
          kind: 'module' as const,
          name: file,
          file,
          container: null,
          spanStart: 1,
          spanEnd: lines,
          signature: null,
          doc: null,
        },
      ],
      edges: [],
    };
  });
}

/** must match every plugin's id scheme: sha256(file::container::name::kind)[:20] */
function moduleId(file: string): string {
  return createHash('sha256').update(`${file}::::${file}::module`).digest('hex').slice(0, 20);
}
