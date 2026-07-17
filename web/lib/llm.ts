/**
 * Server-side bridge to the LLM provider layer (issue #42 / ADR-10). Like
 * lib/librarian.ts, the web app imports the parent package's compiled output
 * instead of owning an SDK dependency — provider selection (LLM_PROVIDER,
 * default anthropic) and model resolution live in the parent registry.
 */
export { resolveProvider } from '../../dist/llm/registry.js';
export { LlmAuthError } from '../../dist/llm/provider.js';
export type { LlmProvider, LlmRequest, LlmResponse } from '../../dist/llm/provider.js';
