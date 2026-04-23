/**
 * Narrow {@link SkillHost} stub for session-manager tests.
 *
 * The session-manager test suite still imports `assistantEventHub` directly
 * so it can capture events published during `join()` / `leave()` / error
 * paths. This helper returns a minimal host that forwards `events.publish`
 * to the real `assistantEventHub` and uses the neutral
 * `buildAssistantEvent` factory for event construction — so every existing
 * `captureHub` subscription in the test file continues to receive the
 * events the session manager emits.
 *
 * The helper is deliberately test-local: PR 16 of the skill-isolation plan
 * introduces a shared `buildTestHost()` under `skills/meet-join/__tests__/`
 * and migrates every meet-join test off direct `assistant/` imports. Until
 * that PR lands, this file is the smallest possible wiring shim — only the
 * facets the session manager actually reads at runtime are populated; the
 * rest intentionally throw so accidental use surfaces as a clear error.
 */

import type {
  AssistantEvent,
  ServerMessage,
  SkillHost,
} from "@vellumai/skill-host-contracts";
import { buildAssistantEvent } from "@vellumai/skill-host-contracts";

import { assistantEventHub } from "../../../../assistant/src/runtime/assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../../../../assistant/src/runtime/assistant-scope.js";

/**
 * Build a stub {@link SkillHost} wired to the real `assistantEventHub`.
 * Only the `events` facet is functional — the other facets throw on
 * access so tests that accidentally start depending on them fail loudly.
 */
export function installSessionManagerTestHost(): SkillHost {
  const noopLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  return {
    logger: { get: () => noopLogger },
    config: {
      isFeatureFlagEnabled: () => false,
      getSection: () => undefined,
    },
    identity: {
      getAssistantName: () => undefined,
      internalAssistantId: DAEMON_INTERNAL_ASSISTANT_ID,
    },
    platform: {
      workspaceDir: () => "/tmp/session-manager-test-workspace",
      vellumRoot: () => "/tmp/session-manager-test-vellum",
      runtimeMode: () => "bare-metal" as never,
    },
    providers: {
      llm: {
        getConfigured: () => {
          throw new Error("unexpected llm.getConfigured");
        },
        userMessage: () => {
          throw new Error("unexpected llm.userMessage");
        },
        extractToolUse: () => null,
        createTimeout: () => new AbortController(),
      },
      stt: {
        listProviderIds: () => [],
        supportsBoundary: () => false,
        resolveStreamingTranscriber: () => {
          throw new Error("unexpected stt.resolveStreamingTranscriber");
        },
      },
      tts: {
        get: () => {
          throw new Error("unexpected tts.get");
        },
        resolveConfig: () => ({}),
      },
      secureKeys: { getProviderKey: async () => null },
    },
    memory: {
      addMessage: async () => ({}),
      wakeAgentForOpportunity: async () => {},
    },
    events: {
      publish: (event: AssistantEvent) =>
        assistantEventHub.publish(event as never),
      subscribe: (filter, cb) =>
        assistantEventHub.subscribe(filter, cb as never),
      buildEvent: (message: ServerMessage, conversationId?: string) =>
        buildAssistantEvent(
          DAEMON_INTERNAL_ASSISTANT_ID,
          message,
          conversationId,
        ),
    },
    registries: {
      registerTools: () => {
        throw new Error("unexpected registries.registerTools");
      },
      registerSkillRoute: () => ({}) as never,
      registerShutdownHook: () => {},
    },
    speakers: { createTracker: () => ({}) },
  };
}
