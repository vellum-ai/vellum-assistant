/**
 * Unit tests for `createWebSyncRouter`'s defensive self-echo drop and
 * its general dispatch behavior.
 *
 * The self-echo drop is a belt-and-suspenders pair to the daemon hub's
 * origin-client-id skip: even if the hub ever delivers a sync_changed
 * with our own origin id (reconnect-redeliver, direct injection path,
 * etc.), the router drops it before any handler can fight the
 * optimistic update the originating mutation already applied.
 *
 * The router resolves "own id" via the module-level singleton in
 * `@/lib/telemetry/client-identity`. Tests read the same singleton to
 * synthesize a matching event id, and pick any other uuid to exercise
 * the "differs" branch.
 *
 * @jest-environment happy-dom
 */

import { describe, expect, test } from "bun:test";

import { createWebSyncRouter } from "@/lib/sync/web-sync-router";
import {
  conversationMessagesSyncTag,
  conversationMetadataSyncTag,
  SYNC_TAGS,
  type SyncChangedEvent,
} from "@/lib/sync/types";
import { getClientId } from "@/lib/telemetry/client-identity";
import { useConversationStore } from "@/domains/conversations/conversation-store";

const OTHER_CLIENT_ID = "22222222-2222-2222-2222-222222222222";

interface HarnessOptions {
  activeConversationId?: string | null;
}

function createHarness(opts: HarnessOptions = {}) {
  useConversationStore.setState({
    activeConversationId: opts.activeConversationId ?? null,
  });
  const calls = {
    invalidateAvatar: 0,
    refreshAssistantIdentity: 0,
    invalidateAssistantConfig: 0,
    invalidateAssistantSounds: 0,
    invalidateAssistantSchedules: 0,
    scheduleConversationListRefetch: 0,
    refreshActiveConversationMessages: 0,
  };
  const router = createWebSyncRouter({
    invalidateAvatar: () => {
      calls.invalidateAvatar += 1;
    },
    refreshAssistantIdentity: async () => {
      calls.refreshAssistantIdentity += 1;
    },
    invalidateAssistantConfig: () => {
      calls.invalidateAssistantConfig += 1;
    },
    invalidateAssistantSounds: () => {
      calls.invalidateAssistantSounds += 1;
    },
    invalidateAssistantSchedules: () => {
      calls.invalidateAssistantSchedules += 1;
    },
    scheduleConversationListRefetch: () => {
      calls.scheduleConversationListRefetch += 1;
    },
    refreshActiveConversationMessages: async () => {
      calls.refreshActiveConversationMessages += 1;
      return { changed: false, messagesAdded: 0, assistantProgress: false };
    },
  });
  return { router, calls };
}

describe("createWebSyncRouter — self-echo drop", () => {
  test("drops sync_changed when originClientId matches our own client id", async () => {
    const { router, calls } = createHarness();
    const event: SyncChangedEvent = {
      type: "sync_changed",
      tags: [SYNC_TAGS.assistantAvatar, SYNC_TAGS.conversationsList],
      originClientId: getClientId(),
    };

    const result = await router.dispatchSyncChanged(event);

    expect(result).toEqual({
      handledTags: [],
      unknownTags: [],
      invokedHandlers: 0,
      errors: [],
    });
    expect(calls.invalidateAvatar).toBe(0);
    expect(calls.scheduleConversationListRefetch).toBe(0);
  });

  test("dispatches normally when originClientId differs from our own", async () => {
    const { router, calls } = createHarness();
    const event: SyncChangedEvent = {
      type: "sync_changed",
      tags: [SYNC_TAGS.assistantAvatar],
      originClientId: OTHER_CLIENT_ID,
    };

    const result = await router.dispatchSyncChanged(event);

    expect(result.handledTags).toEqual([SYNC_TAGS.assistantAvatar]);
    expect(result.invokedHandlers).toBe(1);
    expect(calls.invalidateAvatar).toBe(1);
  });

  test("dispatches normally when originClientId is absent", async () => {
    // Daemon-internal emissions (agent loop, FS watcher, schedules) and
    // routes that haven't been plumbed through omit originClientId. They
    // must continue to invalidate the local cache regardless of which
    // tab/client is listening.
    const { router, calls } = createHarness();
    const event: SyncChangedEvent = {
      type: "sync_changed",
      tags: [SYNC_TAGS.conversationsList],
    };

    const result = await router.dispatchSyncChanged(event);

    expect(result.handledTags).toEqual([SYNC_TAGS.conversationsList]);
    expect(calls.scheduleConversationListRefetch).toBe(1);
  });

  test("does not drop when originClientId is empty string", async () => {
    // An empty origin id should never have been emitted in the first
    // place — the daemon trims and only sets the field when truthy.
    // Pin the invariant: even if "" sneaks through, we still dispatch.
    // Empty is never a real match.
    const { router, calls } = createHarness();
    const event: SyncChangedEvent = {
      type: "sync_changed",
      tags: [SYNC_TAGS.assistantAvatar],
      originClientId: "",
    };

    const result = await router.dispatchSyncChanged(event);

    expect(result.handledTags).toEqual([SYNC_TAGS.assistantAvatar]);
    expect(calls.invalidateAvatar).toBe(1);
  });

  test("drops multi-tag self-echo without firing any handler", async () => {
    const conversationId = "conv-123";
    const { router, calls } = createHarness({
      activeConversationId: conversationId,
    });
    const event: SyncChangedEvent = {
      type: "sync_changed",
      tags: [
        SYNC_TAGS.assistantAvatar,
        SYNC_TAGS.conversationsList,
        conversationMetadataSyncTag(conversationId),
        conversationMessagesSyncTag(conversationId),
      ],
      originClientId: getClientId(),
    };

    await router.dispatchSyncChanged(event);

    expect(calls.invalidateAvatar).toBe(0);
    expect(calls.scheduleConversationListRefetch).toBe(0);
    expect(calls.refreshActiveConversationMessages).toBe(0);
  });

  test("dispatchReconnect is unaffected by the self-echo drop", async () => {
    // Reconnect-driven refetches are intentionally not gated by origin
    // id — on reconnect we have no idea which events we missed, so we
    // re-fetch the world. The drop applies only to live `sync_changed`.
    const { router, calls } = createHarness();

    const result = await router.dispatchReconnect();

    expect(result.dispatch.invokedHandlers).toBeGreaterThan(0);
    expect(calls.invalidateAvatar).toBe(1);
    expect(calls.scheduleConversationListRefetch).toBe(1);
  });
});
