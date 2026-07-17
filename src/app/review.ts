/**
 * Review generation — the LLM stage of Phase 2 (§4-③).
 *
 * The system's value is WHAT we hand the model (the Context Pack); review
 * prose is the model's job. Findings come back as structured JSON (the
 * request's outputSchema) so the CLI/Actions layer can render or post them
 * without parsing free text.
 *
 * Since #42 (ADR-10) this file is provider-agnostic: it builds an LlmRequest
 * and completes it through the provider the registry resolves — which
 * provider that is (Anthropic by default) is not this layer's business.
 */
import { renderReviewPack, type ReviewPack } from '../core/contextpack.js';
import type { LlmProvider, LlmRequest } from '../llm/provider.js';
import { resolveProvider } from '../llm/registry.js';

export interface ReviewFinding {
  severity: 'critical' | 'major' | 'minor' | 'info';
  file: string;
  line: number | null;
  title: string;
  body: string;
  /** which context-pack sections ground this finding (self-improvement signal, §4-⑤) */
  evidence: string[];
}

export interface ReviewResult {
  summary: string;
  findings: ReviewFinding[];
  verdict: 'approve' | 'request_changes' | 'comment';
}

const SYSTEM_PROMPT = `あなたはコードレビュアーである。PR の diff と、コードグラフから機械的に組み立てられた Context Pack(変更コード・呼び出し元・呼び出し先・関連テスト)を受け取る。

レビューの重心は「diff 単体では正しいが、システム全体では壊れている」変更の検出にある。diff だけを見るレビュアーには見えない問題 — 呼び出し元の想定を破る戻り値の変更、テストが固定している挙動との矛盾、データ形状の消費者との不整合 — を Context Pack を根拠に指摘する。

規律:
- 見つけた問題はすべて報告する。確信が持てないものや軽微なものも、severity と confidence を付けて出す。重要度での自己検閲はしない(下流でフィルタされる)。
- 各指摘の evidence には、根拠にした Context Pack のセクション名(diff / changed / callers / callees / tests / related)を列挙する。diff 以外を根拠にした指摘こそがこのシステムの価値である。
- スタイルや命名の好みは報告しない。挙動・契約・テスト整合性に集中する。
- Context Pack に無い情報を推測で補わない。文脈が足りない場合はその旨を summary に書く。`;

const OUTPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    summary: { type: 'string', description: '変更の要約と全体評価(日本語、2-4文)' },
    verdict: { type: 'string', enum: ['approve', 'request_changes', 'comment'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['critical', 'major', 'minor', 'info'] },
          file: { type: 'string' },
          line: { type: ['integer', 'null'] },
          title: { type: 'string' },
          body: { type: 'string', description: '指摘の本文(日本語)。根拠となるコードを引用する' },
          evidence: { type: 'array', items: { type: 'string' } },
        },
        required: ['severity', 'file', 'line', 'title', 'body', 'evidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'verdict', 'findings'],
  additionalProperties: false,
};

export function buildReviewRequest(pack: ReviewPack): LlmRequest {
  return {
    system: SYSTEM_PROMPT,
    maxTokens: 16000,
    outputSchema: { name: 'review', schema: OUTPUT_SCHEMA },
    messages: [
      {
        role: 'user' as const,
        content: `次の変更をレビューしてください。\n\n${renderReviewPack(pack)}`,
      },
    ],
  };
}

export async function generateReview(
  pack: ReviewPack,
  opts: { model?: string; provider?: LlmProvider } = {}
): Promise<ReviewResult> {
  const provider = opts.provider ?? resolveProvider({ model: opts.model });
  const response = await provider.complete(buildReviewRequest(pack));
  if (response.refused) {
    throw new Error('review request was refused by the model safety layer');
  }
  return (response.structured ?? JSON.parse(response.text)) as ReviewResult;
}

/** GitHub-comment-ready markdown for a review result. */
export function renderReviewMarkdown(r: ReviewResult): string {
  const icon = { critical: '🟥', major: '🟧', minor: '🟨', info: 'ℹ️' } as const;
  const lines = [
    `## Codex Librarian review — ${r.verdict}`,
    '',
    r.summary,
    '',
  ];
  if (r.findings.length === 0) {
    lines.push('指摘事項はありません。');
  }
  for (const f of r.findings) {
    const loc = f.line !== null ? `${f.file}:${f.line}` : f.file;
    lines.push(
      `### ${icon[f.severity]} ${f.title}`,
      `\`${loc}\` — severity: ${f.severity} / 根拠: ${f.evidence.join(', ')}`,
      '',
      f.body,
      ''
    );
  }
  const graphBased = r.findings.filter((f) => f.evidence.some((e) => e !== 'diff')).length;
  lines.push('---', `_findings: ${r.findings.length} (うち diff 外の文脈を根拠にしたもの: ${graphBased})_`);
  return lines.join('\n');
}
