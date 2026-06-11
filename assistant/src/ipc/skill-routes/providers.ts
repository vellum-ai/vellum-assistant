/**
 * Skill IPC routes for the `host.providers.*` facet.
 *
 * These mirror the in-process delegates used by `DaemonSkillHost`
 * (see `assistant/src/daemon/daemon-skill-host.ts`). Every handler is a
 * thin pass-through to the underlying daemon module, with schema-validated
 * params and a serializable return shape.
 *
 * Sub-facets:
 * - `host.providers.llm.complete`
 * - `host.providers.stt.listProviderIds`
 * - `host.providers.stt.supportsBoundary`
 * - `host.providers.tts.resolveConfig`
 * - `host.providers.tts.get`         (returns a handle-as-id; synthesis
 *                                     happens in-skill via the returned config)
 * - `host.providers.secureKeys.getProviderKey`
 */

import { z } from "zod";

import { getConfig } from "../../config/loader.js";
import { LLMCallSiteEnum } from "../../config/schemas/llm.js";
import {
  createTimeout,
  getConfiguredProvider,
} from "../../providers/provider-send-message.js";
import {
  listProviderIds as sttListProviderIds,
  supportsBoundary as sttSupportsBoundary,
} from "../../providers/speech-to-text/provider-catalog.js";
import type {
  Message,
  SendMessageConfig,
  ToolDefinition,
} from "../../providers/types.js";
import { getProviderKeyAsync } from "../../security/secure-keys.js";
import { getTtsProvider } from "../../tts/provider-registry.js";
import { resolveTtsConfig } from "../../tts/tts-config-resolver.js";
import type { SkillIpcRoute } from "../skill-ipc-types.js";

// -- Param schemas --------------------------------------------------------

/**
 * Default timeout for a skill LLM completion when the caller supplies none.
 * Generous (120s) because first-party skills — the meet-join consent monitor
 * and chat-opportunity detector — flow through this route and pass their own
 * tighter `timeoutMs`. Without any bound a stalled provider call would block
 * the skill IPC channel indefinitely.
 */
const DEFAULT_LLM_COMPLETE_TIMEOUT_MS = 120_000;

/**
 * LLM completion request. The IPC surface only accepts the serializable
 * subset of `Provider.sendMessage(messages, options?)`.
 * The non-serializable `signal` is replaced by a serializable `timeoutMs`:
 * callers express cancellation as a deadline the daemon enforces locally via
 * `createTimeout`. Streaming deltas (`onEvent`) belong on future streaming
 * routes, not this one-shot RPC.
 */
const ProvidersLlmCompleteParams = z.object({
  callSite: LLMCallSiteEnum,
  messages: z.array(z.unknown()),
  tools: z.array(z.unknown()).optional(),
  systemPrompt: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  /** Caller-supplied deadline in ms. Defaults to 120s when omitted. */
  timeoutMs: z.number().int().positive().optional(),
});

const ProvidersSttSupportsBoundaryParams = z.object({
  id: z.string().min(1),
  boundary: z.string().min(1),
});

const ProvidersTtsGetParams = z.object({
  id: z.string().min(1),
});

const ProvidersSecureKeysGetParams = z.object({
  id: z.string().min(1),
});

// -- Handlers -------------------------------------------------------------

async function handleLlmComplete(params?: Record<string, unknown>) {
  const { callSite, messages, tools, systemPrompt, config, timeoutMs } =
    ProvidersLlmCompleteParams.parse(params);
  const provider = await getConfiguredProvider(callSite);
  if (!provider) {
    // The skill IPC server serializes a thrown Error's message as the wire
    // `error` field, so a plain Error is the structured error convention here
    // (matching sibling skill-route handlers).
    throw new Error(
      `host.providers.llm.complete: no provider configured for callSite '${callSite}'`,
    );
  }
  const { signal, cleanup } = createTimeout(
    timeoutMs ?? DEFAULT_LLM_COMPLETE_TIMEOUT_MS,
  );
  try {
    return await provider.sendMessage(messages as Message[], {
      tools: tools as ToolDefinition[] | undefined,
      systemPrompt,
      config: { ...((config as SendMessageConfig) ?? {}), callSite },
      signal,
    });
  } finally {
    cleanup();
  }
}

function handleSttListProviderIds(): string[] {
  return [...sttListProviderIds()];
}

function handleSttSupportsBoundary(params?: Record<string, unknown>): boolean {
  const { id, boundary } = ProvidersSttSupportsBoundaryParams.parse(params);
  // Unknown ids return `false`, so the narrowing cast is safe.
  return sttSupportsBoundary(id as never, boundary as never);
}

function handleTtsResolveConfig(): ReturnType<typeof resolveTtsConfig> {
  return resolveTtsConfig(getConfig());
}

/**
 * Return a serializable handle for a TTS provider. The actual `TtsProvider`
 * object holds method closures that cannot cross the IPC boundary — skills
 * identify the provider by id and do synthesis via the config returned from
 * `resolveConfig`. We still invoke `getTtsProvider(id)` here so an invalid
 * id surfaces as an error rather than a silently invalid handle.
 */
function handleTtsGet(params?: Record<string, unknown>): { id: string } {
  const { id } = ProvidersTtsGetParams.parse(params);
  const provider = getTtsProvider(id as never);
  return { id: provider.id };
}

async function handleSecureKeysGetProviderKey(
  params?: Record<string, unknown>,
): Promise<string | null> {
  const { id } = ProvidersSecureKeysGetParams.parse(params);
  // Daemon helper returns `undefined` for absent keys; the contract returns
  // `null`. Normalize at the boundary.
  return (await getProviderKeyAsync(id)) ?? null;
}

// -- Route definitions ----------------------------------------------------

export const providersLlmCompleteRoute: SkillIpcRoute = {
  method: "host.providers.llm.complete",
  handler: handleLlmComplete,
};

export const providersSttListProviderIdsRoute: SkillIpcRoute = {
  method: "host.providers.stt.listProviderIds",
  handler: handleSttListProviderIds,
};

export const providersSttSupportsBoundaryRoute: SkillIpcRoute = {
  method: "host.providers.stt.supportsBoundary",
  handler: handleSttSupportsBoundary,
};

export const providersTtsResolveConfigRoute: SkillIpcRoute = {
  method: "host.providers.tts.resolveConfig",
  handler: handleTtsResolveConfig,
};

export const providersTtsGetRoute: SkillIpcRoute = {
  method: "host.providers.tts.get",
  handler: handleTtsGet,
};

export const providersSecureKeysGetProviderKeyRoute: SkillIpcRoute = {
  method: "host.providers.secureKeys.getProviderKey",
  handler: handleSecureKeysGetProviderKey,
};

/** All `host.providers.*` IPC routes. */
export const providerSkillRoutes: SkillIpcRoute[] = [
  providersLlmCompleteRoute,
  providersSttListProviderIdsRoute,
  providersSttSupportsBoundaryRoute,
  providersTtsResolveConfigRoute,
  providersTtsGetRoute,
  providersSecureKeysGetProviderKeyRoute,
];
