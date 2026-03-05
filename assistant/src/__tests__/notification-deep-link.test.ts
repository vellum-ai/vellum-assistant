/**
 * Regression tests for Vellum notification deep-link metadata.
 *
 * Validates that the VellumAdapter broadcasts notification_intent with
 * deepLinkMetadata, and that the broadcaster correctly passes deepLinkTarget
 * from the decision through to the adapter payload — regardless of whether
 * the conversation was newly created or reused.
 */

import { describe, expect, mock, test } from "bun:test";

// -- Mocks (must be declared before importing modules that depend on them) ----

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import type { ServerMessage } from "../daemon/ipc-contract.js";
import { VellumAdapter } from "../notifications/adapters/macos.js";

// -- Tests -------------------------------------------------------------------

describe("notification deep-link metadata", () => {
  describe("VellumAdapter", () => {
    test("broadcasts notification_intent with deepLinkMetadata from payload", async () => {
      const messages: ServerMessage[] = [];
      const adapter = new VellumAdapter((msg) => messages.push(msg));

      await adapter.send(
        {
          sourceEventName: "test.event",
          copy: { title: "Alert", body: "Something happened" },
          deepLinkTarget: {
            conversationId: "conv-123",
            threadType: "notification",
          },
        },
        { channel: "vellum" },
      );

      expect(messages).toHaveLength(1);
      const msg = messages[0] as unknown as Record<string, unknown>;
      expect(msg.type).toBe("notification_intent");
      expect(msg.title).toBe("Alert");
      expect(msg.body).toBe("Something happened");
      expect(msg.deepLinkMetadata).toEqual({
        conversationId: "conv-123",
        threadType: "notification",
      });
    });

    test("broadcasts notification_intent without deepLinkMetadata when absent", async () => {
      const messages: ServerMessage[] = [];
      const adapter = new VellumAdapter((msg) => messages.push(msg));

      await adapter.send(
        {
          sourceEventName: "test.event",
          copy: { title: "Alert", body: "No deep link" },
        },
        { channel: "vellum" },
      );

      expect(messages).toHaveLength(1);
      const msg = messages[0] as unknown as Record<string, unknown>;
      expect(msg.type).toBe("notification_intent");
      expect(msg.deepLinkMetadata).toBeUndefined();
    });

    test("includes conversationId in deepLinkMetadata for navigation", async () => {
      const messages: ServerMessage[] = [];
      const adapter = new VellumAdapter((msg) => messages.push(msg));

      const conversationId = "conv-deep-link-test";
      await adapter.send(
        {
          sourceEventName: "guardian.question",
          copy: { title: "Guardian Question", body: "What is the code?" },
          deepLinkTarget: { conversationId },
        },
        { channel: "vellum" },
      );

      const msg = messages[0] as unknown as Record<string, unknown>;
      const metadata = msg.deepLinkMetadata as Record<string, unknown>;
      expect(metadata.conversationId).toBe(conversationId);
    });

    test("returns success: true on successful broadcast", async () => {
      const adapter = new VellumAdapter(() => {});

      const result = await adapter.send(
        {
          sourceEventName: "test.event",
          copy: { title: "T", body: "B" },
        },
        { channel: "vellum" },
      );

      expect(result.success).toBe(true);
    });

    test("returns success: false when broadcast throws", async () => {
      const adapter = new VellumAdapter(() => {
        throw new Error("IPC connection lost");
      });

      const result = await adapter.send(
        {
          sourceEventName: "test.event",
          copy: { title: "T", body: "B" },
        },
        { channel: "vellum" },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("IPC connection lost");
    });

    test("sourceEventName is included in the IPC payload", async () => {
      const messages: ServerMessage[] = [];
      const adapter = new VellumAdapter((msg) => messages.push(msg));

      await adapter.send(
        {
          sourceEventName: "guardian.question",
          copy: { title: "Alert", body: "Body" },
        },
        { channel: "vellum" },
      );

      const msg = messages[0] as unknown as Record<string, unknown>;
      expect(msg.sourceEventName).toBe("guardian.question");
    });

    test("deepLinkMetadata with conversationId enables client-side navigation", async () => {
      const messages: ServerMessage[] = [];
      const adapter = new VellumAdapter((msg) => messages.push(msg));

      // Simulate a notification that should deep-link to a specific conversation
      await adapter.send(
        {
          sourceEventName: "activity.complete",
          copy: { title: "Task Done", body: "Your task has completed" },
          deepLinkTarget: {
            conversationId: "conv-task-run-42",
            workItemId: "work-item-7",
          },
        },
        { channel: "vellum" },
      );

      const msg = messages[0] as unknown as Record<string, unknown>;
      const metadata = msg.deepLinkMetadata as Record<string, unknown>;
      expect(metadata.conversationId).toBe("conv-task-run-42");
      expect(metadata.workItemId).toBe("work-item-7");
    });

    test("deep-link payload includes messageId when present", async () => {
      const messages: ServerMessage[] = [];
      const adapter = new VellumAdapter((msg) => messages.push(msg));

      await adapter.send(
        {
          sourceEventName: "guardian.question",
          copy: { title: "Question", body: "Body" },
          deepLinkTarget: { conversationId: "conv-1", messageId: "msg-1" },
        },
        { channel: "vellum" },
      );

      const msg = messages[0] as unknown as Record<string, unknown>;
      const metadata = msg.deepLinkMetadata as Record<string, unknown>;
      expect(metadata.messageId).toBe("msg-1");
    });

    // ── Deep-link conversationId present regardless of reuse/new ──────

    test("deep-link payload includes conversationId for a newly created conversation", async () => {
      const messages: ServerMessage[] = [];
      const adapter = new VellumAdapter((msg) => messages.push(msg));

      // Simulates the broadcaster merging pairing.conversationId into deep-link
      // for a newly created notification thread (start_new path)
      await adapter.send(
        {
          sourceEventName: "reminder.fired",
          copy: { title: "Reminder", body: "Take out the trash" },
          deepLinkTarget: { conversationId: "conv-new-thread-001" },
        },
        { channel: "vellum" },
      );

      const msg = messages[0] as unknown as Record<string, unknown>;
      const metadata = msg.deepLinkMetadata as Record<string, unknown>;
      expect(metadata.conversationId).toBe("conv-new-thread-001");
    });

    test("deep-link payload includes conversationId for a reused conversation", async () => {
      const messages: ServerMessage[] = [];
      const adapter = new VellumAdapter((msg) => messages.push(msg));

      // Simulates the broadcaster merging pairing.conversationId into deep-link
      // for a reused notification thread (reuse_existing path)
      await adapter.send(
        {
          sourceEventName: "reminder.fired",
          copy: {
            title: "Follow-up",
            body: "Still need to take out the trash",
          },
          deepLinkTarget: { conversationId: "conv-reused-thread-042" },
        },
        { channel: "vellum" },
      );

      const msg = messages[0] as unknown as Record<string, unknown>;
      const metadata = msg.deepLinkMetadata as Record<string, unknown>;
      expect(metadata.conversationId).toBe("conv-reused-thread-042");
    });

    // ── Reused thread deep-link stability regressions ─────────────────

    test("reused thread preserves the same conversationId across follow-up notifications", async () => {
      const messages: ServerMessage[] = [];
      const adapter = new VellumAdapter((msg) => messages.push(msg));

      const stableConversationId = "conv-bound-telegram-dest-001";

      // First notification to a bound destination
      await adapter.send(
        {
          sourceEventName: "guardian.question",
          copy: { title: "Question 1", body: "Allow file read?" },
          deepLinkTarget: {
            conversationId: stableConversationId,
            messageId: "msg-seed-1",
          },
        },
        { channel: "vellum" },
      );

      // Follow-up notification reuses the same bound conversation
      await adapter.send(
        {
          sourceEventName: "guardian.question",
          copy: { title: "Question 2", body: "Allow network access?" },
          deepLinkTarget: {
            conversationId: stableConversationId,
            messageId: "msg-seed-2",
          },
        },
        { channel: "vellum" },
      );

      expect(messages).toHaveLength(2);

      const meta1 = (messages[0] as unknown as Record<string, unknown>)
        .deepLinkMetadata as Record<string, unknown>;
      const meta2 = (messages[1] as unknown as Record<string, unknown>)
        .deepLinkMetadata as Record<string, unknown>;

      // Both deep links point to the same conversation
      expect(meta1.conversationId).toBe(stableConversationId);
      expect(meta2.conversationId).toBe(stableConversationId);

      // But each has a distinct messageId for scroll-to-message targeting
      expect(meta1.messageId).toBe("msg-seed-1");
      expect(meta2.messageId).toBe("msg-seed-2");
    });

    test("reused thread deep-link messageId changes per delivery for scroll targeting", async () => {
      const messages: ServerMessage[] = [];
      const adapter = new VellumAdapter((msg) => messages.push(msg));

      const conversationId = "conv-reused-scroll-test";

      await adapter.send(
        {
          sourceEventName: "reminder.fired",
          copy: { title: "Reminder", body: "First" },
          deepLinkTarget: { conversationId, messageId: "msg-a" },
        },
        { channel: "vellum" },
      );

      await adapter.send(
        {
          sourceEventName: "reminder.fired",
          copy: { title: "Reminder", body: "Second" },
          deepLinkTarget: { conversationId, messageId: "msg-b" },
        },
        { channel: "vellum" },
      );

      const meta1 = (messages[0] as unknown as Record<string, unknown>)
        .deepLinkMetadata as Record<string, unknown>;
      const meta2 = (messages[1] as unknown as Record<string, unknown>)
        .deepLinkMetadata as Record<string, unknown>;

      // Same conversation but different message targets
      expect(meta1.conversationId).toBe(conversationId);
      expect(meta2.conversationId).toBe(conversationId);
      expect(meta1.messageId).not.toBe(meta2.messageId);
    });

    test("deep-link metadata is stable when conversation is reused via binding-key continuation", async () => {
      const messages: ServerMessage[] = [];
      const adapter = new VellumAdapter((msg) => messages.push(msg));

      // Simulates the binding-key continuation path: multiple notifications
      // to the same SMS destination reuse the same bound conversation, and
      // the deep-link metadata should reflect the bound conversation ID
      // rather than creating a new one each time.
      const boundConvId = "conv-sms-bound-+15551234567";

      for (const body of ["Alert 1", "Alert 2", "Alert 3"]) {
        await adapter.send(
          {
            sourceEventName: "activity.complete",
            copy: { title: "Activity", body },
            deepLinkTarget: { conversationId: boundConvId },
          },
          { channel: "vellum" },
        );
      }

      expect(messages).toHaveLength(3);

      // All three notifications deep-link to the same bound conversation
      for (const msg of messages) {
        const metadata = (msg as unknown as Record<string, unknown>)
          .deepLinkMetadata as Record<string, unknown>;
        expect(metadata.conversationId).toBe(boundConvId);
      }
    });
  });
});
