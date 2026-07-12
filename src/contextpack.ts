/**
 * Context Pack assembly — the deliverable of the Context Engine (§4-③).
 *
 * Takes the flat, ranked retrieval result and shapes it into the sectioned
 * pack the architecture specifies: 変更コード / 呼び出し元 / 呼び出し先 /
 * 関連テスト / 関連コード. The 類似実装 (semantic) section is intentionally
 * absent until the embedding stage exists — the renderer says so explicitly
 * rather than silently omitting it, so the LLM knows what it wasn't given.
 */
import type { ContextItem, ContextPack } from './retrieval.js';

export interface ReviewPack {
  diff: string;
  changed: ContextItem[];
  callers: ContextItem[];
  callees: ContextItem[];
  tests: ContextItem[];
  related: ContextItem[];
  unknownFiles: string[];
  elidedCount: number;
  usedChars: number;
  budget: number;
}

const TEST_FILE = /\.(test|spec)\.[jt]sx?$|(^|\/)__tests__\/|_test\.go$|Test\.php$/;

function isTest(item: ContextItem): boolean {
  return item.kind === 'testblock' || TEST_FILE.test(item.file);
}

/**
 * Section assignment: tests win over direction; only DIRECT call edges count
 * as callers/callees (a 2-hop "←calls·→calls" is a sibling through a shared
 * caller, not a dependency of the change — it goes to related).
 */
function section(item: ContextItem): 'callers' | 'callees' | 'tests' | 'related' {
  if (isTest(item)) return 'tests';
  if (item.via === '←calls') return 'callers';
  if (item.via === '→calls') return 'callees';
  return 'related';
}

export function assembleReviewPack(diff: string, pack: ContextPack): ReviewPack {
  const out: ReviewPack = {
    diff,
    changed: pack.seeds,
    callers: [],
    callees: [],
    tests: [],
    related: [],
    unknownFiles: pack.unknownFiles,
    elidedCount: pack.elided.length,
    usedChars: pack.usedChars,
    budget: pack.budget,
  };
  for (const item of pack.items) out[section(item)].push(item);
  return out;
}

function renderItems(items: ContextItem[]): string {
  return items
    .map((i) => {
      const head = `#### ${i.name} (${i.kind}) — \`${i.file}:${i.span[0]}-${i.span[1]}\` [via ${i.via}]`;
      return i.text !== undefined ? `${head}\n\`\`\`\n${i.text}\n\`\`\`` : head;
    })
    .join('\n\n');
}

/** Markdown rendering handed to the LLM (and to humans via `librarian pack`). */
export function renderReviewPack(p: ReviewPack): string {
  const parts: string[] = ['# Context Pack'];
  parts.push(
    '## 変更 diff\n```diff\n' + p.diff.trimEnd() + '\n```',
    '## 変更されたコード(シード)\n' + (renderItems(p.changed) || '(none)'),
    '## 呼び出し元(この変更に依存するコード)\n' + (renderItems(p.callers) || '(none)'),
    '## 呼び出し先(この変更が依存するコード)\n' + (renderItems(p.callees) || '(none)'),
    '## 関連テスト\n' + (renderItems(p.tests) || '(none)'),
    '## 関連コード\n' + (renderItems(p.related) || '(none)')
  );
  const notes: string[] = [];
  if (p.unknownFiles.length > 0) {
    notes.push(`インデックス外のファイル(文脈なし): ${p.unknownFiles.join(', ')}`);
  }
  if (p.elidedCount > 0) {
    notes.push(`予算 (${p.budget} chars) により ${p.elidedCount} 件の候補を省略。`);
  }
  notes.push('類似実装セクションは未実装(意味検索は Phase 4)。構造グラフ由来の文脈のみ。');
  parts.push('## Notes\n' + notes.map((n) => `- ${n}`).join('\n'));
  return parts.join('\n\n');
}
