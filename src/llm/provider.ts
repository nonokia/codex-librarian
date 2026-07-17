/**
 * LLM provider abstraction (issue #42 / ADR-10).
 *
 * The product body (src/core, src/app, web/app) talks to LLMs exclusively
 * through this interface: "system prompt + user content (+ structured-output
 * schema) → text or structured object". Provider names, SDKs, endpoints and
 * auth schemes live in src/llm/providers/ and are selected by the registry —
 * nothing provider-specific may leak into this file.
 */

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  maxTokens: number;
  /**
   * When set, the provider must return `structured` parsed against this JSON
   * Schema. Providers without native schema enforcement satisfy it by
   * embedding the schema in the prompt and parsing the reply (ADR-10's
   * least-common-denominator rule).
   */
  outputSchema?: { name: string; schema: Record<string, unknown> };
}

export interface LlmResponse {
  text: string;
  /** present iff the request carried an outputSchema */
  structured?: unknown;
  /** the model declined to answer (providers without a refusal signal report false) */
  refused: boolean;
}

export interface LlmProvider {
  /** registry name, e.g. 'anthropic' */
  readonly name: string;
  /** the model this provider instance is bound to */
  readonly model: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

/**
 * Credentials are missing or rejected. Callers (the ask route's 503 path)
 * branch on this class instead of on provider-specific error types.
 */
export class LlmAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmAuthError';
  }
}

/**
 * A structured-output reply could not be parsed against the schema. No
 * automatic retry: the failure is surfaced deterministically with the raw
 * reply attached, and retrying is the caller's (or the human's) decision.
 */
export class LlmParseError extends Error {
  readonly raw: string;
  constructor(message: string, raw: string) {
    super(`${message}: ${raw.slice(0, 200)}`);
    this.name = 'LlmParseError';
    this.raw = raw;
  }
}
