/**
 * Self-index (#15): index this repository with its own CLI and materialize
 * the two committed artifacts —
 *   .librarian/self.db  (query layer: `librarian graph/pack --db …`)
 *   .librarian/MAP.md   (grep-able layer: `librarian map` output)
 *
 * `--check` (drift detection): rebuild the map from a scratch index in a
 * temp db and diff it against the committed MAP.md; exit 1 when stale.
 * Both modes drive the real CLI so the artifacts and the check can never
 * disagree on rendering.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// self-index scope: our own domain only — fixtures and extractor helpers are
// other-domain noise (issue #15)
const INCLUDE = ['src', 'web'];
const DB = '.librarian/self.db';
const MAP = '.librarian/MAP.md';

const cli = (args, opts = {}) =>
  execFileSync(process.execPath, ['dist/cli.js', ...args], { encoding: 'utf8', ...opts });

const includeFlags = INCLUDE.flatMap((p) => ['--include', p]);
const check = process.argv.includes('--check');

if (check) {
  const dir = mkdtempSync(join(tmpdir(), 'selfindex-check-'));
  try {
    const db = join(dir, 'self.db');
    cli(['index', '.', '--db', db, ...includeFlags], { stdio: ['ignore', 'ignore', 'inherit'] });
    const fresh = cli(['map', '--db', db]);
    let committed = null;
    try {
      committed = readFileSync(MAP, 'utf8');
    } catch {
      /* missing map counts as stale */
    }
    if (fresh !== committed) {
      console.error(
        JSON.stringify({
          stale: true,
          map: MAP,
          hint: 'run `npm run selfindex` and commit .librarian/self.db + .librarian/MAP.md',
        })
      );
      process.exit(1);
    }
    console.log(JSON.stringify({ stale: false, map: MAP }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} else {
  const report = JSON.parse(cli(['index', '.', '--db', DB, ...includeFlags]));
  writeFileSync(MAP, cli(['map', '--db', DB]));
  console.log(JSON.stringify({ db: DB, map: MAP, ...report }));
}
