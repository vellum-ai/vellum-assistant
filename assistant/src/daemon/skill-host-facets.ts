/**
 * Shared `SkillHost` facet builders — the single source of truth for
 * constructing the daemon-backed facets that bridge the neutral
 * `@vellumai/skill-host-contracts` interfaces to the daemon's existing
 * singleton modules.
 *
 * Two callers consume these builders:
 * - {@link createDaemonSkillHost} (in `daemon-skill-host.ts`) assembles the
 *   full nine-facet `SkillHost` for in-process first-party skills.
 * - The external-plugin bootstrap (`external-plugins-bootstrap.ts`) assembles
 *   the subset exposed on `InitContext.host`, so an external plugin reaches
 *   providers/memory/events/config the same way a skill does — without
 *   reaching into `assistant/` with relative imports.
 *
 * Where a delegate's signature does not line up exactly with the contract
 * — pino's `(meta, msg)` log methods vs the contract's `(msg, meta)`,
 * `getAssistantName()` returning `null` vs the contract's `undefined`,
 * `getProviderKeyAsync()` returning `undefined` vs the contract's `null`,
 * `buildAssistantEvent()` signature differences, etc. — the adaptation
 * happens here so the contract stays narrow and the underlying daemon APIs
 * stay unchanged.
 */

import type {
  AssistantEvent,
  AssistantEventCallback,
  ConfigFacet,
  EmbeddingsFacet,
  EventsFacet,
  Filter,
  HistoryConversation,
  HistoryFacet,
  HistoryMessage,
  HistoryPage,
  IdentityFacet,
  LlmProvidersFacet,
  Logger,
  LoggerFacet,
  MemoryFacet,
  PlatformFacet,
  Provider,
  ProvidersFacet,
  RegistriesFacet,
  SecureKeysFacet,
  ServerMessage,
  SkillRoute,
  SkillRouteHandle,
  SpeakersFacet,
  StreamingTranscriber,
  SttProvidersFacet,
  Subscription,
  ToolUse,
  TtsConfig,
  TtsProvider,
  TtsProvidersFacet,
  UserMessage,
  VectorCollection,
  VectorStoreFacet,
} from "@vellumai/skill-host-contracts";

import { SpeakerIdentityTracker } from "../calls/speaker-identification.js";
import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getConfig, getNestedValue } from "../config/loader.js";
import type { LLMCallSite } from "../config/schemas/llm.js";
import {
  addMessage,
  type ConversationRow,
  getConversation,
  getMessagesPaginated,
  type MessageRow,
} from "../persistence/conversation-crud.js";
import { embedWithBackend } from "../persistence/embeddings/embedding-backend.js";
import { openPluginVectorCollection } from "../persistence/embeddings/plugin-vector-store.js";
import {
  createTimeout,
  extractToolUse,
  getConfiguredProvider,
  userMessage,
} from "../providers/provider-send-message.js";
import {
  listProviderIds as sttListProviderIds,
  supportsBoundary as sttSupportsBoundary,
} from "../providers/speech-to-text/provider-catalog.js";
import { resolveStreamingTranscriber as sttResolveStreamingTranscriber } from "../providers/speech-to-text/resolve.js";
import { wakeAgentForOpportunity } from "../runtime/agent-wake.js";
import { buildAssistantEvent } from "../runtime/assistant-event.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { getDaemonRuntimeMode } from "../runtime/runtime-mode.js";
import { registerSkillRoute } from "../runtime/skill-route-registry.js";
import { getProviderKeyAsync } from "../security/secure-keys.js";
import { registerExternalTools } from "../tools/registry.js";
import { getTtsProvider } from "../tts/provider-registry.js";
import { resolveTtsConfig } from "../tts/tts-config-resolver.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceDir, vellumRoot } from "../util/platform.js";
import { getAssistantName } from "./identity-helpers.js";
import { registerShutdownHook } from "./shutdown-registry.js";

/**
 * Adapt pino's `(meta, msg)` call shape to the contract's `(msg, meta?)`
 * shape so callers can use `host.logger.get(...).info("msg", { ... })`
 * without knowing about pino.
 */
function adaptLogger(name: string): Logger {
  const pino = getLogger(name);
  return {
    debug: (msg, meta) => pino.debug(meta ?? {}, msg),
    info: (msg, meta) => pino.info(meta ?? {}, msg),
    warn: (msg, meta) => pino.warn(meta ?? {}, msg),
    error: (msg, meta) => pino.error(meta ?? {}, msg),
  };
}

export function buildLoggerFacet(hostId: string): LoggerFacet {
  return {
    get: (name) => adaptLogger(`${hostId}:${name}`),
  };
}

export function buildConfigFacet(): ConfigFacet {
  return {
    isFeatureFlagEnabled: (key) =>
      isAssistantFeatureFlagEnabled(key, getConfig()),
    getSection: <T>(path: string): T | undefined =>
      getNestedValue(
        getConfig() as unknown as Record<string, unknown>,
        path,
      ) as T | undefined,
  };
}

export function buildIdentityFacet(): IdentityFacet {
  return {
    // Contract uses `undefined`; delegate returns `null`. Normalize here.
    getAssistantName: () => getAssistantName() ?? undefined,
  };
}

export function buildPlatformFacet(): PlatformFacet {
  return {
    workspaceDir: () => getWorkspaceDir(),
    vellumRoot: () => vellumRoot(),
    runtimeMode: () => getDaemonRuntimeMode(),
  };
}

function buildLlmProvidersFacet(): LlmProvidersFacet {
  return {
    getConfigured: async (callSite) =>
      (await getConfiguredProvider(callSite as LLMCallSite)) as Provider | null,
    userMessage: (text) => userMessage(text) as unknown as UserMessage,
    extractToolUse: (response) =>
      (extractToolUse(response as Parameters<typeof extractToolUse>[0]) ??
        null) as ToolUse | null,
    createTimeout,
  };
}

function buildSttProvidersFacet(): SttProvidersFacet {
  return {
    listProviderIds: () => [...sttListProviderIds()],
    // Contract asks whether a provider id is usable; we check against the
    // daemon-streaming boundary which is the only boundary skills currently
    // care about. Passes the id through to the daemon helper.
    supportsBoundary: (id) =>
      sttSupportsBoundary(
        id as Parameters<typeof sttSupportsBoundary>[0],
        "daemon-streaming",
      ),
    resolveStreamingTranscriber: async (spec) =>
      (await sttResolveStreamingTranscriber(
        spec as Parameters<typeof sttResolveStreamingTranscriber>[0],
      )) as StreamingTranscriber | null,
  };
}

function buildTtsProvidersFacet(): TtsProvidersFacet {
  return {
    get: (id) => getTtsProvider(id as never) as unknown as TtsProvider,
    // `resolveTtsConfig` needs the current config; the contract takes no
    // args, so we fetch `getConfig()` at call time and pass it through.
    resolveConfig: () => resolveTtsConfig(getConfig()) as unknown as TtsConfig,
  };
}

function buildSecureKeysFacet(): SecureKeysFacet {
  return {
    // Daemon returns `undefined`; contract returns `null`. Normalize.
    getProviderKey: async (id) => (await getProviderKeyAsync(id)) ?? null,
  };
}

export function buildProvidersFacet(): ProvidersFacet {
  return {
    llm: buildLlmProvidersFacet(),
    stt: buildSttProvidersFacet(),
    tts: buildTtsProvidersFacet(),
    secureKeys: buildSecureKeysFacet(),
  };
}

export function buildMemoryFacet(): MemoryFacet {
  return {
    addMessage: addMessage,
    wakeAgentForOpportunity: async (req) => {
      // Contract returns `void`; daemon returns a `WakeResult` that
      // in-process callers don't need through the host surface.
      await wakeAgentForOpportunity(req as never);
    },
  };
}

/**
 * Whether a message row is flagged `hidden` in its metadata (internal
 * scaffolding such as retrospective instructions). Mirrors the UI-facing
 * history loader's visibility rule so the facet never surfaces a row the
 * displayed transcript would suppress.
 */
function isHiddenHistoryMessage(metadata: string | null): boolean {
  if (!metadata) return false;
  try {
    const meta = JSON.parse(metadata) as { hidden?: unknown };
    return meta?.hidden === true;
  } catch {
    return false;
  }
}

/**
 * The same visibility predicate the UI history loads apply: drop rows flagged
 * hidden, and keep only renderable `user`/`assistant` turns (agent-context
 * `system` scaffolding never reaches a plugin).
 */
function isVisibleHistoryMessage(row: MessageRow): boolean {
  return (
    !isHiddenHistoryMessage(row.metadata) &&
    (row.role === "user" || row.role === "assistant")
  );
}

function toHistoryMessage(row: MessageRow): HistoryMessage {
  return {
    id: row.id,
    conversationId: row.conversationId,
    // Narrowed by `isVisibleHistoryMessage` to the renderable union.
    role: row.role === "assistant" ? "assistant" : "user",
    content: row.content,
    createdAt: row.createdAt,
    metadata: row.metadata,
  };
}

function toHistoryConversation(row: ConversationRow): HistoryConversation {
  return {
    id: row.id,
    title: row.title,
    conversationType: row.conversationType,
    source: row.source,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastMessageAt: row.lastMessageAt,
    archivedAt: row.archivedAt,
  };
}

export function buildHistoryFacet(): HistoryFacet {
  return {
    getConversation: async (conversationId) => {
      const row = getConversation(conversationId);
      return row ? toHistoryConversation(row) : null;
    },
    getRecentMessages: async (conversationId, n) => {
      // Newest `n` visible rows, then re-ordered oldest→newest to match the
      // natural read order a consolidation pass expects.
      const { messages } = getMessagesPaginated(
        conversationId,
        Math.max(0, n),
        undefined,
        isVisibleHistoryMessage,
      );
      return messages.map(toHistoryMessage);
    },
    getMessages: async (conversationId, options): Promise<HistoryPage> => {
      const { messages, hasMore, nextCursor } = getMessagesPaginated(
        conversationId,
        options?.limit,
        options?.beforeTimestamp,
        isVisibleHistoryMessage,
      );
      // The next (older) page anchors on this page's oldest visible row; the
      // store-supplied `nextCursor` only fires on a scan-cap-truncated empty
      // page, so fall back to it when there is no oldest row to anchor on.
      const oldest = messages[0];
      const resumeCursor = hasMore
        ? (oldest?.createdAt ?? nextCursor?.createdAt)
        : undefined;
      return {
        messages: messages.map(toHistoryMessage),
        hasMore,
        ...(resumeCursor !== undefined ? { nextCursor: resumeCursor } : {}),
      };
    },
  };
}

export function buildEventsFacet(): EventsFacet {
  return {
    // Contract types events/messages as opaque supersets of the daemon's
    // narrower discriminated unions; cast at the boundary so
    // `assistantEventHub` continues to accept its existing type.
    publish: (event: AssistantEvent) =>
      assistantEventHub.publish(event as never),
    subscribe: (filter: Filter, cb: AssistantEventCallback): Subscription =>
      assistantEventHub.subscribe({
        type: "process",
        filter,
        callback: cb,
      }),
    // `buildAssistantEvent` takes `(message, conversationId?)`.
    buildEvent: (message: ServerMessage, conversationId?: string) =>
      buildAssistantEvent(message as never, conversationId) as AssistantEvent,
  };
}

export function buildRegistriesFacet(hostId: string): RegistriesFacet {
  return {
    // Contract's `Tool` is structurally independent of the daemon's
    // overlay (`assistant/src/tools/types.ts`); the assistant-side
    // registry accepts the daemon flavor. Skills construct tools via
    // helpers that already produce the daemon shape, so a cast at this
    // boundary is safe. The contract's `registerTools(provider)` stays
    // single-arg — skill code never needs to know its own id — and this
    // adapter pairs the provider with the owner derived from the
    // surrounding {@link buildRegistriesFacet} closure.
    registerTools: (provider) =>
      registerExternalTools({ kind: "skill", id: hostId }, provider as never),
    registerSkillRoute: (route: SkillRoute): SkillRouteHandle =>
      registerSkillRoute(route) as unknown as SkillRouteHandle,
    // Namespace hook names by hostId so two owners using the same label
    // (e.g. "cleanup") cannot silently overwrite each other's entries in
    // the shared shutdown-hook map.
    registerShutdownHook: (name, hook) =>
      registerShutdownHook(`${hostId}:${name}`, hook),
  };
}

export function buildSpeakersFacet(): SpeakersFacet {
  return {
    createTracker: () => new SpeakerIdentityTracker(),
  };
}

export function buildEmbeddingsFacet(): EmbeddingsFacet {
  return {
    embed: async (texts, opts) => {
      // The host resolves the active embedding backend from config; the
      // plugin only ever sees vectors out, never the backend identity.
      const { vectors } = await embedWithBackend(getConfig(), texts, {
        signal: opts?.signal,
      });
      return vectors;
    },
  };
}

export function buildVectorStoreFacet(hostId: string): VectorStoreFacet {
  return {
    collection: async (name, options): Promise<VectorCollection> => {
      // Namespacing by hostId happens inside `openPluginVectorCollection`,
      // so two hosts asking for the same `name` get distinct collections.
      const handle = openPluginVectorCollection(
        hostId,
        name,
        options.vectorSize,
      );
      return {
        upsert: (points) => handle.upsert(points),
        search: (vector, limit) => handle.search(vector, limit),
        delete: (ids) => handle.delete(ids),
      };
    },
  };
}
