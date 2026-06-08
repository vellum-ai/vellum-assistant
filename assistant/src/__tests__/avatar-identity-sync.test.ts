import { describe, expect, test } from "bun:test";

import { SYNC_TAGS } from "../daemon/message-types/sync.js";
import type { AssistantEvent } from "../runtime/assistant-event.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { ROUTES as AVATAR_ROUTES } from "../runtime/routes/avatar-routes.js";
import {
  publishIdentityChanged,
  publishIdentityIntroChanged,
} from "../runtime/sync/resource-sync-events.js";

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for avatar/identity sync event");
}

describe("avatar and identity sync events", () => {
  test("notify_avatar_updated emits legacy avatar event and sync tag", async () => {
    const received: AssistantEvent[] = [];
    const subscription = assistantEventHub.subscribe({
      type: "process",
      callback: (event) => {
        received.push(event);
      },
    });

    try {
      const route = AVATAR_ROUTES.find(
        (candidate) => candidate.operationId === "notify_avatar_updated",
      );
      expect(route).toBeDefined();

      await route!.handler({});
      await waitFor(() => received.length === 2);

      expect(received.map((event) => event.message.type)).toEqual([
        "avatar_updated",
        "sync_changed",
      ]);
      expect(received[1].message).toEqual({
        type: "sync_changed",
        tags: [SYNC_TAGS.assistantAvatar],
      });
    } finally {
      subscription.dispose();
    }
  });

  test("identity changes emit legacy identity event and identity sync tags", async () => {
    const received: AssistantEvent[] = [];
    const subscription = assistantEventHub.subscribe({
      type: "process",
      callback: (event) => {
        received.push(event);
      },
    });

    try {
      publishIdentityChanged({
        name: "Sage",
        role: "Assistant",
        personality: "Calm",
        emoji: ":sparkles:",
        home: "San Francisco",
      });
      await waitFor(() => received.length === 2);

      expect(received.map((event) => event.message.type)).toEqual([
        "identity_changed",
        "sync_changed",
      ]);
      expect(received[0].message).toMatchObject({
        type: "identity_changed",
        name: "Sage",
      });
      expect(received[1].message).toEqual({
        type: "sync_changed",
        tags: [SYNC_TAGS.assistantIdentity, SYNC_TAGS.assistantIdentityIntro],
      });
    } finally {
      subscription.dispose();
    }
  });

  test("identity intro changes emit only the identity intro sync tag", async () => {
    const received: AssistantEvent[] = [];
    const subscription = assistantEventHub.subscribe({
      type: "process",
      callback: (event) => {
        received.push(event);
      },
    });

    try {
      publishIdentityIntroChanged();
      await waitFor(() => received.length === 1);

      expect(received[0].message).toEqual({
        type: "sync_changed",
        tags: [SYNC_TAGS.assistantIdentityIntro],
      });
    } finally {
      subscription.dispose();
    }
  });
});
