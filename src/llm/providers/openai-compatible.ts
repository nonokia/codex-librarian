/**
 * Generic provider for OpenAI-compatible chat-completions endpoints (issue
 * #42 / ADR-10) — gateways and proxies an organization runs in front of its
 * LLM traffic. Everything environment-specific (base URL, key, model) comes
 * in via options; no vendor name or endpoint is hardcoded here.
 *
 * Uses global fetch (Node >= 22) — no SDK dependency. The base URL is the
 * API root (typically ending in /v1); this provider appends /chat/completions.
 *
 * Structured output is satisfied by the least-common-denominator rule:
 * the JSON Schema is embedded in the system prompt and the reply is parsed
 * (fence-tolerant). Native schema enforcement is NOT assumed — gateways
 * differ on response_format support, and a silently ignored parameter is
 * worse than an explicit prompt contract.
 */
import {
  LlmAuthError,
  LlmParseError,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from '../provider.js';

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** test seam */
  fetchImpl?: typeof fetch;
}

/** The prompt contract used when the endpoint has no native schema enforcement. */
export function schemaInstruction(outputSchema: { name: string; schema: Record<string, unknown> }): string {
  return [
    '',
    '',
    `# 出力形式(厳守)`,
    `応答は "${outputSchema.name}" の JSON オブジェクトのみとする。次の JSON Schema に厳密に従うこと。`,
    '説明文・前置き・markdown フェンスを付けず、JSON ドキュメント 1 個だけを出力する。',
    '```json',
    JSON.stringify(outputSchema.schema),
    '```',
  ].join('\n');
}

/** Parse a (possibly fenced or prefixed) JSON reply. Throws LlmParseError — never retries. */
export function parseStructuredReply(text: string): unknown {
  const stripped = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  try {
    return JSON.parse(stripped);
  } catch {
    // last resort: the outermost {...} span (models sometimes prepend prose)
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(stripped.slice(start, end + 1));
      } catch {
        /* fall through to the typed error */
      }
    }
    throw new LlmParseError('構造化出力の JSON パースに失敗しました', text);
  }
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name = 'openai-compatible';
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAiCompatibleOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const system = req.outputSchema ? req.system + schemaInstruction(req.outputSchema) : req.system;
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: req.maxTokens,
        messages: [{ role: 'system', content: system }, ...req.messages],
      }),
    });

    if (res.status === 401 || res.status === 403) {
      throw new LlmAuthError(
        `LLM エンドポイントが認証を拒否しました(HTTP ${res.status})。LLM_OPENAI_COMPATIBLE_API_KEY を確認してください。`
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`LLM エンドポイントがエラーを返しました(HTTP ${res.status}): ${body.slice(0, 300)}`);
    }

    const data = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== 'string') {
      throw new Error('LLM エンドポイントの応答形式が chat-completions と互換ではありません(choices[0].message.content が無い)');
    }
    return {
      text,
      ...(req.outputSchema ? { structured: parseStructuredReply(text) } : {}),
      // chat-completions has no portable refusal signal; a refusal surfaces as text.
      refused: false,
    };
  }
}
