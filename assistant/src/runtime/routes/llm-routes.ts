/**
 * Standalone LLM text generation endpoint.
 *
 * POST /v1/llm/generate
 *
 * Accepts a messages array, optional tools, optional system prompt, and an
 * optional modelIntent, then routes the request through the daemon's configured
 * provider (getConfiguredProvider). This lets host-target skill tools trigger
 * one-shot LLM calls via INTERNAL_GATEWAY_BASE_URL without depending on a
 * specific provider SDK or API key — the daemon handles provider selection and
 * credentials transparently.
 *
 * Request body:
 *   {
 *     messages: Array<{ role: 'user'|'assistant'; content: string }>;
 *     tools?: ToolDefinition[];
 *     system?: string;
 *     modelIntent?: 'latency-optimized'|'quality-optimized'|'vision-optimized';
 *     max_tokens?: number;
 *     tool_choice?: { type: string; name?: string };
 *   }
 *
 * Response body (on success):
 *   The raw ProviderResponse object (with `content` array).
 *
 * Response body (on error):
 *   { error: string; code: string }
 */

import { getConfiguredProvider } from '../../providers/provider-send-message.js';
import type { Message, ModelIntent, ToolDefinition } from '../../providers/types.js';
import { httpError } from '../http-errors.js';

const VALID_MODEL_INTENTS = new Set<string>(['latency-optimized', 'quality-optimized', 'vision-optimized']);

export async function handleLlmGenerate(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await req.json() as Record<string, unknown>;
  } catch {
    return httpError('BAD_REQUEST', 'Invalid JSON body', 400);
  }

  const messages = body.messages as Message[] | undefined;
  if (!Array.isArray(messages) || messages.length === 0) {
    return httpError('BAD_REQUEST', 'messages is required and must be a non-empty array', 400);
  }

  const tools = Array.isArray(body.tools) ? (body.tools as ToolDefinition[]) : [];
  const system = typeof body.system === 'string' ? body.system : undefined;
  const rawModelIntent = typeof body.modelIntent === 'string' ? body.modelIntent : 'latency-optimized';
  const modelIntent: ModelIntent = VALID_MODEL_INTENTS.has(rawModelIntent)
    ? (rawModelIntent as ModelIntent)
    : 'latency-optimized';
  const maxTokens = typeof body.max_tokens === 'number' ? body.max_tokens : 4096;
  const toolChoice = body.tool_choice as Record<string, unknown> | undefined;

  const provider = getConfiguredProvider();
  if (!provider) {
    return httpError('SERVICE_UNAVAILABLE', 'No LLM provider configured', 503);
  }

  try {
    const response = await provider.sendMessage(messages, tools, system, {
      config: { modelIntent, max_tokens: maxTokens, ...(toolChoice ? { tool_choice: toolChoice } : {}) },
    });
    return Response.json(response);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return httpError('INTERNAL_ERROR', `LLM generation failed: ${msg}`, 500);
  }
}
