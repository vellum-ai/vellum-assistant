/**
 * `DaemonSkillHost` — in-process concretion of the neutral `SkillHost`
 * interface defined in `@vellumai/skill-host-contracts`.
 *
 * `createDaemonSkillHost(skillId)` returns a plain object whose nine facets
 * (`logger`, `config`, `identity`, `platform`, `providers`, `memory`,
 * `events`, `registries`, `speakers`) delegate to the daemon's existing
 * singleton modules. First-party skills that live in-process receive this
 * host via the bootstrap path instead of reaching into `assistant/` with
 * relative imports.
 *
 * Where a delegate's signature does not line up exactly with the contract
 * — pino's `(meta, msg)` log methods vs the contract's `(msg, meta)`,
 * `getAssistantName()` returning `null` vs the contract's `undefined`,
 * `getProviderKeyAsync()` returning `undefined` vs the contract's `null`,
 * `buildAssistantEvent()` signature differences, etc. — the
 * adaptation happens inside this file so the contract stays narrow and the
 * underlying daemon APIs stay unchanged.
 */

import type {
  AssistantEvent,
  AssistantEventCallback,
  ConfigFacet,
  EventsFacet,
  Filter,
  IdentityFacet,
  InsertMessageFn,
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
  SkillHost,
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
} from "@vellumai/skill-host-contracts";

import { SpeakerIdentityTracker } from "../calls/speaker-identification.js";
import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getConfig, getNestedValue } from "../config/loader.js";
import type { LLMCallSite } from "../config/schemas/llm.js";
import { addMessage } from "../memory/conversation-crud.js";
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
 * shape so skills can use `host.logger.get(...).info("msg", { ... })`
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

function buildLoggerFacet(skillId: string): LoggerFacet {
  return {
    get: (name) => adaptLogger(`${skillId}:${name}`),
  };
}

function buildConfigFacet(): ConfigFacet {
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

function buildIdentityFacet(): IdentityFacet {
  return {
    // Contract uses `undefined`; delegate returns `null`. Normalize here.
    getAssistantName: () => getAssistantName() ?? undefined,
  };
}

function buildPlatformFacet(): PlatformFacet {
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

function buildProvidersFacet(): ProvidersFacet {
  return {
    llm: buildLlmProvidersFacet(),
    stt: buildSttProvidersFacet(),
    tts: buildTtsProvidersFacet(),
    secureKeys: buildSecureKeysFacet(),
  };
}

function buildMemoryFacet(): MemoryFacet {
  return {
    addMessage: addMessage as InsertMessageFn,
    wakeAgentForOpportunity: async (req) => {
      // Contract returns `void`; daemon returns a `WakeResult` that
      // in-process callers don't need through the host surface.
      await wakeAgentForOpportunity(req as never);
    },
  };
}

function buildEventsFacet(): EventsFacet {
  return {
    // Contract types events/messages as opaque supersets of the daemon's
    // narrower discriminated unions; cast at the boundary so
    // `assistantEventHub` continues to accept its existing type.
    publish: (event: AssistantEvent) =>
      assistantEventHub.publish(event as never),
    subscribe: (filter: Filter, cb: AssistantEventCallback): Subscription =>
      assistantEventHub.subscribe(filter, cb as never),
    // `buildAssistantEvent` takes `(message, conversationId?)`.
    buildEvent: (message: ServerMessage, conversationId?: string) =>
      buildAssistantEvent(message as never, conversationId) as AssistantEvent,
  };
}

function buildRegistriesFacet(skillId: string): RegistriesFacet {
  return {
    // Contract's `Tool` is structurally independent of the daemon's
    // overlay (`assistant/src/tools/types.ts`); the assistant-side
    // registry accepts the daemon flavor. Skills construct tools via
    // helpers that already produce the daemon shape, so a cast at this
    // boundary is safe.
    registerTools: (provider) => registerExternalTools(provider as never),
    registerSkillRoute: (route: SkillRoute): SkillRouteHandle =>
      registerSkillRoute(route) as unknown as SkillRouteHandle,
    // Namespace hook names by skillId so two skills using the same label
    // (e.g. "cleanup") cannot silently overwrite each other's entries in
    // the shared shutdown-hook map.
    registerShutdownHook: (name, hook) =>
      registerShutdownHook(`${skillId}:${name}`, hook),
  };
}

function buildSpeakersFacet(): SpeakersFacet {
  return {
    createTracker: () => new SpeakerIdentityTracker(),
  };
}

/**
 * Build a `SkillHost` for the in-process first-party skill identified by
 * `skillId`. The id prefixes logger names (so cross-cutting diagnostics
 * carry the owning skill) and namespaces shutdown-hook registrations (so
 * two skills using the same hook label cannot silently overwrite each
 * other in the shared shutdown-hook map).
 */
export function createDaemonSkillHost(skillId: string): SkillHost {
  return {
    logger: buildLoggerFacet(skillId),
    config: buildConfigFacet(),
    identity: buildIdentityFacet(),
    platform: buildPlatformFacet(),
    providers: buildProvidersFacet(),
    memory: buildMemoryFacet(),
    events: buildEventsFacet(),
    registries: buildRegistriesFacet(skillId),
    speakers: buildSpeakersFacet(),
  };
}
