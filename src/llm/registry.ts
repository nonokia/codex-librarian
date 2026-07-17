/**
 * LLM provider registry (issue #42 / ADR-10).
 *
 * The trust model mirrors the extractor registry (ADR-7): selection is
 * EXPLICIT — `LLM_PROVIDER` names a built-in, an unknown name is an error,
 * and there is no implicit fallback from one provider to another. The
 * default (`anthropic`) keeps the pre-#42 contract: ANTHROPIC_API_KEY alone
 * is a complete configuration.
 *
 * This file is the only place outside src/llm/providers/ that knows provider
 * names. Model selection is unified here too: explicit option (CLI --model)
 * > LLM_MODEL > LIBRARIAN_MODEL (backward-compatible alias) > the provider's
 * own default (only anthropic has one).
 */
import type { LlmProvider } from './provider.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAiCompatibleProvider } from './providers/openai-compatible.js';

export const PROVIDER_NAMES = ['anthropic', 'openai-compatible'] as const;

export interface ResolveProviderOptions {
  /** explicit model override (e.g. `librarian review --model M`); wins over env */
  model?: string;
  /** test seam; defaults to process.env */
  env?: Record<string, string | undefined>;
}

export function resolveProvider(opts: ResolveProviderOptions = {}): LlmProvider {
  const env = opts.env ?? process.env;
  const name = env.LLM_PROVIDER ?? 'anthropic';
  const model = opts.model ?? env.LLM_MODEL ?? env.LIBRARIAN_MODEL;

  switch (name) {
    case 'anthropic':
      return new AnthropicProvider({ model });
    case 'openai-compatible': {
      const baseUrl = env.LLM_OPENAI_COMPATIBLE_BASE_URL;
      if (!baseUrl) {
        throw new Error(
          'LLM_PROVIDER=openai-compatible には LLM_OPENAI_COMPATIBLE_BASE_URL(API ルート、通常 /v1 で終わる)が必要です'
        );
      }
      if (!model) {
        throw new Error(
          'LLM_PROVIDER=openai-compatible にはモデル指定(LLM_MODEL または --model)が必要です — 既定モデルは持ちません'
        );
      }
      return new OpenAiCompatibleProvider({
        baseUrl,
        model,
        apiKey: env.LLM_OPENAI_COMPATIBLE_API_KEY,
      });
    }
    default:
      throw new Error(
        `unknown LLM_PROVIDER "${name}"(有効: ${PROVIDER_NAMES.join(', ')})— 暗黙フォールバックはしません(ADR-10)`
      );
  }
}
