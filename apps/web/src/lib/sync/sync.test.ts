import { describe, expect, test } from "bun:test";

import {
  createSyncTagRegistry,
  type SyncHandlerContext,
} from "@/lib/sync/tag-registry.js";
import {
  conversationMetadataSyncTag,
  conversationMessagesSyncTag,
  isConversationMessagesSyncTag,
  parseConversationSyncTag,
  SYNC_TAGS,
  type SyncChangedEvent,
} from "@/lib/sync/types.js";

describe("sync tag helpers", () => {
  test("builds and parses conversation metadata tags", () => {
    const tag = conversationMetadataSyncTag("conversation-123");

    expect(tag).toBe("conversation:conversation-123:metadata");
    expect(parseConversationSyncTag(tag)).toEqual({
      conversationId: "conversation-123",
      resource: "metadata",
    });
  });

  test("identifies conversation message tags", () => {
    const tag = conversationMessagesSyncTag("conversation-123");

    expect(isConversationMessagesSyncTag(tag)).toBe(true);
    expect(parseConversationSyncTag("assistant:self:avatar")).toBeNull();
  });
});

describe("SyncTagRegistry", () => {
  test("dispatches exact tag handlers and ignores unknown tags", async () => {
    const registry = createSyncTagRegistry();
    const seen: SyncHandlerContext[] = [];

    registry.register(SYNC_TAGS.assistantAvatar, (context) => {
      seen.push(context);
    });

    const event: SyncChangedEvent = {
      type: "sync_changed",
      tags: [SYNC_TAGS.assistantAvatar, "unknown:tag"],
    };
    const result = await registry.dispatch(event);

    expect(seen.map((context) => context.tag)).toEqual([
      SYNC_TAGS.assistantAvatar,
    ]);
    expect(seen[0]!.reason).toBe("live");
    expect(seen[0]!.event).toBe(event);
    expect(result).toMatchObject({
      handledTags: [SYNC_TAGS.assistantAvatar],
      unknownTags: ["unknown:tag"],
      invokedHandlers: 1,
      errors: [],
    });
  });

  test("dedupes tags before invoking handlers", async () => {
    const registry = createSyncTagRegistry();
    let calls = 0;

    registry.register(SYNC_TAGS.conversationsList, () => {
      calls += 1;
    });

    const result = await registry.dispatch({
      type: "sync_changed",
      tags: [SYNC_TAGS.conversationsList, SYNC_TAGS.conversationsList],
    });

    expect(calls).toBe(1);
    expect(result.handledTags).toEqual([SYNC_TAGS.conversationsList]);
    expect(result.invokedHandlers).toBe(1);
  });

  test("dispatches all handlers for a tag and captures handler errors", async () => {
    const registry = createSyncTagRegistry();
    const calls: string[] = [];
    const thrown = new Error("boom");

    registry.register(SYNC_TAGS.assistantIdentity, () => {
      calls.push("first");
      throw thrown;
    });
    registry.register(SYNC_TAGS.assistantIdentity, () => {
      calls.push("second");
    });

    const result = await registry.dispatch({
      type: "sync_changed",
      tags: [SYNC_TAGS.assistantIdentity],
    });

    expect(calls).toEqual(["first", "second"]);
    expect(result.invokedHandlers).toBe(2);
    expect(result.errors).toEqual([
      {
        tag: SYNC_TAGS.assistantIdentity,
        error: thrown,
      },
    ]);
  });

  test("supports pattern handlers for dynamic conversation tags", async () => {
    const registry = createSyncTagRegistry();
    const seen: string[] = [];

    registry.registerPattern(isConversationMessagesSyncTag, ({ tag }) => {
      seen.push(tag);
    });

    const result = await registry.dispatch({
      type: "sync_changed",
      tags: [
        conversationMessagesSyncTag("conversation-123"),
        conversationMetadataSyncTag("conversation-123"),
      ],
    });

    expect(seen).toEqual([conversationMessagesSyncTag("conversation-123")]);
    expect(result.handledTags).toEqual([
      conversationMessagesSyncTag("conversation-123"),
    ]);
    expect(result.unknownTags).toEqual([
      conversationMetadataSyncTag("conversation-123"),
    ]);
  });

  test("supports regex pattern handlers without leaking lastIndex state", async () => {
    const registry = createSyncTagRegistry();
    const seen: string[] = [];
    const matcher = /^conversation:[^:]+:metadata$/g;

    registry.registerPattern(matcher, ({ tag }) => {
      seen.push(tag);
    });

    await registry.dispatch({
      type: "sync_changed",
      tags: [
        conversationMetadataSyncTag("first"),
        conversationMetadataSyncTag("second"),
      ],
    });

    expect(seen).toEqual([
      conversationMetadataSyncTag("first"),
      conversationMetadataSyncTag("second"),
    ]);
  });

  test("dispatchReconnect runs currently registered reconnect handlers", async () => {
    const registry = createSyncTagRegistry();
    const seen: Array<Pick<SyncHandlerContext, "tag" | "reason">> = [];

    registry.register(SYNC_TAGS.assistantAvatar, ({ tag, reason }) => {
      seen.push({ tag, reason });
    });
    registry.register(
      SYNC_TAGS.assistantSounds,
      ({ tag, reason }) => {
        seen.push({ tag, reason });
      },
      { runOnReconnect: false },
    );
    registry.registerPattern(
      isConversationMessagesSyncTag,
      ({ tag, reason }) => {
        seen.push({ tag, reason });
      },
      {
        reconnectTags: () => [conversationMessagesSyncTag("active")],
      },
    );

    const result = await registry.dispatchReconnect();

    expect(seen).toEqual([
      { tag: SYNC_TAGS.assistantAvatar, reason: "reconnect" },
      { tag: conversationMessagesSyncTag("active"), reason: "reconnect" },
    ]);
    expect(result.handledTags).toEqual([
      SYNC_TAGS.assistantAvatar,
      conversationMessagesSyncTag("active"),
    ]);
  });

  test("dispatchReconnect does not invoke exact handlers that opted out", async () => {
    const registry = createSyncTagRegistry();
    const seen: string[] = [];

    registry.register(
      conversationMessagesSyncTag("active"),
      () => {
        seen.push("exact");
      },
      { runOnReconnect: false },
    );
    registry.registerPattern(
      isConversationMessagesSyncTag,
      () => {
        seen.push("pattern");
      },
      {
        reconnectTags: () => [conversationMessagesSyncTag("active")],
      },
    );

    await registry.dispatchReconnect();

    expect(seen).toEqual(["pattern"]);
  });

  test("dispose unregisters handlers", async () => {
    const registry = createSyncTagRegistry();
    let calls = 0;

    const registration = registry.register(SYNC_TAGS.assistantConfig, () => {
      calls += 1;
    });
    registration.dispose();

    const result = await registry.dispatch({
      type: "sync_changed",
      tags: [SYNC_TAGS.assistantConfig],
    });

    expect(calls).toBe(0);
    expect(result.unknownTags).toEqual([SYNC_TAGS.assistantConfig]);
  });
});
