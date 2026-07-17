/**
 * LLM provider layer (issue #42 / ADR-10): registry selection is explicit
 * with no implicit fallback; the openai-compatible provider satisfies
 * structured output via the prompt contract; the anthropic provider maps the
 * abstraction onto the official SDK unchanged from the pre-#42 inline code.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { LlmAuthError, LlmParseError, type LlmRequest } from '../llm/provider.js';
import { resolveProvider } from '../llm/registry.js';
import { AnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from '../llm/providers/anthropic.js';
import { OpenAiCompatibleProvider, parseStructuredReply } from '../llm/providers/openai-compatible.js';

const REQ: LlmRequest = {
  system: 'you are a test',
  messages: [{ role: 'user', content: 'hello' }],
  maxTokens: 100,
};

// ---------- registry ----------

test('registry defaults to anthropic with the provider default model', () => {
  const p = resolveProvider({ env: {} });
  assert.equal(p.name, 'anthropic');
  assert.equal(p.model, DEFAULT_ANTHROPIC_MODEL);
});

test('registry model precedence: explicit > LLM_MODEL > LIBRARIAN_MODEL', () => {
  assert.equal(resolveProvider({ env: { LIBRARIAN_MODEL: 'legacy' } }).model, 'legacy');
  assert.equal(resolveProvider({ env: { LIBRARIAN_MODEL: 'legacy', LLM_MODEL: 'unified' } }).model, 'unified');
  assert.equal(
    resolveProvider({ model: 'flag', env: { LIBRARIAN_MODEL: 'legacy', LLM_MODEL: 'unified' } }).model,
    'flag'
  );
});

test('registry rejects an unknown provider — no implicit fallback', () => {
  assert.throws(() => resolveProvider({ env: { LLM_PROVIDER: 'mystery' } }), /unknown LLM_PROVIDER "mystery"/);
});

test('registry: openai-compatible requires base URL and model explicitly', () => {
  assert.throws(
    () => resolveProvider({ env: { LLM_PROVIDER: 'openai-compatible' } }),
    /LLM_OPENAI_COMPATIBLE_BASE_URL/
  );
  assert.throws(
    () =>
      resolveProvider({
        env: { LLM_PROVIDER: 'openai-compatible', LLM_OPENAI_COMPATIBLE_BASE_URL: 'https://gw.internal/v1' },
      }),
    /LLM_MODEL/
  );
  const p = resolveProvider({
    env: {
      LLM_PROVIDER: 'openai-compatible',
      LLM_OPENAI_COMPATIBLE_BASE_URL: 'https://gw.internal/v1',
      LLM_MODEL: 'gw-model',
    },
  });
  assert.equal(p.name, 'openai-compatible');
  assert.equal(p.model, 'gw-model');
});

// ---------- openai-compatible provider ----------

function fakeFetch(reply: string, opts: { status?: number } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const status = opts.status ?? 200;
    return new Response(
      status === 200 ? JSON.stringify({ choices: [{ message: { content: reply } }] }) : reply,
      { status }
    );
  }) as typeof fetch;
  return { calls, impl };
}

test('openai-compatible posts a chat-completions request with bearer auth', async () => {
  const { calls, impl } = fakeFetch('hi');
  const p = new OpenAiCompatibleProvider({
    baseUrl: 'https://gw.internal/v1/',
    model: 'gw-model',
    apiKey: 'k',
    fetchImpl: impl,
  });
  const res = await p.complete(REQ);
  assert.equal(res.text, 'hi');
  assert.equal(res.refused, false);
  assert.equal(res.structured, undefined);

  assert.equal(calls[0].url, 'https://gw.internal/v1/chat/completions');
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer k');
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.model, 'gw-model');
  assert.equal(body.max_tokens, 100);
  assert.deepEqual(body.messages[0], { role: 'system', content: 'you are a test' });
  assert.deepEqual(body.messages[1], { role: 'user', content: 'hello' });
});

test('openai-compatible embeds the schema in the system prompt and parses the reply', async () => {
  const { calls, impl } = fakeFetch('```json\n{"ok": true}\n```');
  const p = new OpenAiCompatibleProvider({ baseUrl: 'https://gw.internal/v1', model: 'm', fetchImpl: impl });
  const res = await p.complete({
    ...REQ,
    outputSchema: { name: 'probe', schema: { type: 'object', properties: { ok: { type: 'boolean' } } } },
  });
  assert.deepEqual(res.structured, { ok: true });

  const body = JSON.parse(String(calls[0].init.body));
  assert.ok(body.messages[0].content.includes('"probe"'), 'schema name reaches the prompt');
  assert.ok(body.messages[0].content.includes('"boolean"'), 'schema body reaches the prompt');
  // no native structured-output parameter is assumed (least common denominator)
  assert.equal(body.response_format, undefined);
});

test('openai-compatible maps 401/403 to LlmAuthError', async () => {
  const { impl } = fakeFetch('denied', { status: 401 });
  const p = new OpenAiCompatibleProvider({ baseUrl: 'https://gw.internal/v1', model: 'm', fetchImpl: impl });
  await assert.rejects(p.complete(REQ), LlmAuthError);
});

test('parseStructuredReply tolerates fences and prose, then fails typed', () => {
  assert.deepEqual(parseStructuredReply('{"a":1}'), { a: 1 });
  assert.deepEqual(parseStructuredReply('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseStructuredReply('回答: {"a":1}'), { a: 1 });
  assert.throws(() => parseStructuredReply('not json at all'), LlmParseError);
});

// ---------- anthropic provider ----------

interface FakeCreateArgs {
  model: string;
  system: string;
  max_tokens: number;
  thinking?: { type: string };
  output_config?: { format: { type: string; schema: object } };
  messages: { role: string; content: string }[];
}

function fakeAnthropic(response: object) {
  const calls: FakeCreateArgs[] = [];
  const client = {
    messages: { create: async (args: FakeCreateArgs) => (calls.push(args), response) },
  };
  // the provider only touches .messages.create, so the cast is contained here
  return { calls, client: client as unknown as Anthropic };
}

test('anthropic provider maps the request onto the official SDK shape', async () => {
  const { calls, client } = fakeAnthropic({
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: '{"ok":true}' }],
  });
  const p = new AnthropicProvider({ model: 'test-model', client });
  const res = await p.complete({
    ...REQ,
    outputSchema: { name: 'probe', schema: { type: 'object' } },
  });
  assert.deepEqual(res.structured, { ok: true });
  assert.equal(res.refused, false);

  assert.equal(calls[0].model, 'test-model');
  assert.equal(calls[0].thinking?.type, 'adaptive');
  assert.equal(calls[0].output_config?.format.type, 'json_schema');
  assert.equal(calls[0].max_tokens, 100);
});

test('anthropic provider reports a refusal instead of throwing', async () => {
  const { client } = fakeAnthropic({ stop_reason: 'refusal', content: [] });
  const p = new AnthropicProvider({ client });
  const res = await p.complete(REQ);
  assert.equal(res.refused, true);
});
