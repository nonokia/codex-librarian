/**
 * Unified-diff parsing — the PR-facing input surface of retrieval (§4-③).
 * Only hunk geometry matters here: which files, which (new-side) line ranges.
 */

export interface FileRanges {
  file: string;
  /** inclusive 1-based line ranges on the post-change side */
  ranges: [number, number][];
}

export function parseUnifiedDiff(text: string): FileRanges[] {
  const byFile = new Map<string, [number, number][]>();
  let oldFile: string | null = null;
  let currentFile: string | null = null;

  for (const line of text.split('\n')) {
    if (line.startsWith('--- ')) {
      oldFile = stripPrefix(line.slice(4).trim());
    } else if (line.startsWith('+++ ')) {
      const f = stripPrefix(line.slice(4).trim());
      // deletions land on the old path so they still map to a file we know
      currentFile = f ?? oldFile;
    } else if (line.startsWith('@@') && currentFile) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) continue;
      const newStart = Number(m[3]);
      const newLen = m[4] === undefined ? 1 : Number(m[4]);
      const oldStart = Number(m[1]);
      // a pure-deletion hunk has newLen 0; anchor it at the old position
      const start = newLen === 0 ? Math.max(1, oldStart) : newStart;
      const end = newLen === 0 ? start : newStart + newLen - 1;
      const list = byFile.get(currentFile) ?? [];
      list.push([start, end]);
      byFile.set(currentFile, list);
    }
  }
  return [...byFile.entries()].map(([file, ranges]) => ({ file, ranges }));
}

/** strip git's a/ b/ prefixes; /dev/null means "no file on this side" */
function stripPrefix(path: string): string | null {
  if (path === '/dev/null') return null;
  if (path.startsWith('a/') || path.startsWith('b/')) return path.slice(2);
  return path;
}
