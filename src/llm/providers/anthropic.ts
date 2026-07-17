/**
 * The default provider (ADR-10): Anthropic's official API, a straight port of
 * the logic that used to live inline in review.ts / the ask route. Works with
 * ANTHROPIC_API_KEY alone — the pre-#42 setup keeps behaving identically.
 */
import Anthropic from '@anthropic-ai/sdk';
import { LlmAuthError, type LlmProvider, type LlmRequest, type LlmResponse } from '../provider.js';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-4-8';

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  readonly model: string;
  private readonly injected?: Anthropic;

  constructor(opts: { model?: string; client?: Anthropic } = {}) {
    this.model = opts.model ?? DEFAULT_ANTHROPIC_MODEL;
    this.injected = opts.client;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    let response: Anthropic.Message;
    try {
      // Constructed lazily: the SDK throws on missing credentials, and that
      // must surface as LlmAuthError, not as a construction-time crash.
      const client = this.injected ?? new Anthropic();
      response = await client.messages.create({
        model: this.model,
        max_tokens: req.maxTokens,
        thinking: { type: 'adaptive' as const },
        system: req.system,
        ...(req.outputSchema
          ? {
              output_config: {
                format: { type: 'json_schema' as const, schema: req.outputSchema.schema },
              },
            }
          : {}),
        messages: req.messages,
      });
    } catch (err) {
      if (
        err instanceof Anthropic.AuthenticationError ||
        (err instanceof Error && /authentication method|ANTHROPIC_API_KEY|apiKey/i.test(err.message))
      ) {
        throw new LlmAuthError(
          'ANTHROPIC_API_KEY が未設定です。環境変数で渡してください(別プロバイダを使う場合は LLM_PROVIDER を指定)。'
        );
      }
      throw err;
    }

    if (response.stop_reason === 'refusal') return { text: '', refused: true };
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    // With output_config the API enforces the schema, so the text is the JSON document.
    return { text, ...(req.outputSchema ? { structured: JSON.parse(text) } : {}), refused: false };
  }
}
