import { describe, expect, mock, test } from "bun:test";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockUpdateMessageFlag = mock(() => Promise.resolve());
const mockListMessages = mock(() =>
  Promise.resolve({
    value: [
      {
        id: "msg-1",
        conversationId: "conv-1",
        subject: "Follow up on proposal",
        from: { emailAddress: { address: "alice@example.com" } },
        receivedDateTime: "2024-01-15T10:00:00Z",
      },
      {
        id: "msg-2",
        conversationId: "conv-2",
        subject: "Pending review",
        from: { emailAddress: { address: "bob@example.com" } },
        receivedDateTime: "2024-01-14T09:00:00Z",
      },
    ],
  }),
);
const mockResolveOAuthConnection = mock(() =>
  Promise.resolve({ id: "conn-1", provider: "outlook" }),
);

mock.module("../messaging/providers/outlook/client.js", () => ({
  updateMessageFlag: mockUpdateMessageFlag,
  listMessages: mockListMessages,
}));

mock.module("../oauth/connection-resolver.js", () => ({
  resolveOAuthConnection: mockResolveOAuthConnection,
}));

import { run } from "../config/bundled-skills/outlook/tools/outlook-follow-up.js";
import type { ToolContext } from "../tools/types.js";

const ctx: ToolContext = {
  workingDir: "/tmp",
  conversationId: "test-conv",
  trustClass: "guardian",
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("outlook_follow_up tool", () => {
  test("returns error when action is missing", async () => {
    const result = await run({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("action is required");
  });

  test("returns error for unknown action", async () => {
    const result = await run({ action: "invalid", confidence: 0.9 }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Unknown action "invalid"');
  });

  // ── track ────────────────────────────────────────────────────────────────

  describe("track", () => {
    test("requires message_id", async () => {
      const result = await run({ action: "track", confidence: 0.9 }, ctx);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("message_id is required");
    });

    test("flags message for follow-up", async () => {
      mockUpdateMessageFlag.mockClear();

      const result = await run(
        { action: "track", message_id: "msg-1", confidence: 0.9 },
        ctx,
      );

      expect(result.isError).toBe(false);
      expect(result.content).toBe("Message flagged for follow-up.");
      expect(mockUpdateMessageFlag).toHaveBeenCalledWith(
        expect.anything(),
        "msg-1",
        { flagStatus: "flagged" },
      );
    });
  });

  // ── complete ─────────────────────────────────────────────────────────────

  describe("complete", () => {
    test("requires message_id", async () => {
      const result = await run({ action: "complete", confidence: 0.9 }, ctx);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("message_id is required");
    });

    test("marks follow-up as complete", async () => {
      mockUpdateMessageFlag.mockClear();

      const result = await run(
        { action: "complete", message_id: "msg-1", confidence: 0.9 },
        ctx,
      );

      expect(result.isError).toBe(false);
      expect(result.content).toBe("Follow-up marked complete.");
      expect(mockUpdateMessageFlag).toHaveBeenCalledWith(
        expect.anything(),
        "msg-1",
        { flagStatus: "complete" },
      );
    });
  });

  // ── untrack ──────────────────────────────────────────────────────────────

  describe("untrack", () => {
    test("requires message_id", async () => {
      const result = await run({ action: "untrack", confidence: 0.9 }, ctx);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("message_id is required");
    });

    test("removes follow-up flag", async () => {
      mockUpdateMessageFlag.mockClear();

      const result = await run(
        { action: "untrack", message_id: "msg-1", confidence: 0.9 },
        ctx,
      );

      expect(result.isError).toBe(false);
      expect(result.content).toBe("Follow-up flag removed.");
      expect(mockUpdateMessageFlag).toHaveBeenCalledWith(
        expect.anything(),
        "msg-1",
        { flagStatus: "notFlagged" },
      );
    });
  });

  // ── list ─────────────────────────────────────────────────────────────────

  describe("list", () => {
    test("returns flagged messages", async () => {
      mockListMessages.mockClear();

      const result = await run({ action: "list", confidence: 0.5 }, ctx);

      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.content);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].subject).toBe("Follow up on proposal");
      expect(parsed[0].from).toBe("alice@example.com");
      expect(parsed[1].subject).toBe("Pending review");

      expect(mockListMessages).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          filter: "flag/flagStatus eq 'flagged'",
          top: 50,
          orderby: "receivedDateTime desc",
        }),
      );
    });

    test("returns message when no flagged messages", async () => {
      mockListMessages.mockImplementationOnce(() =>
        Promise.resolve({ value: [] }),
      );

      const result = await run({ action: "list", confidence: 0.5 }, ctx);

      expect(result.isError).toBe(false);
      expect(result.content).toContain("No messages are currently flagged");
    });
  });

  // ── error handling ───────────────────────────────────────────────────────

  test("returns error on API failure", async () => {
    mockUpdateMessageFlag.mockImplementationOnce(() =>
      Promise.reject(new Error("Graph API 500: Internal Server Error")),
    );

    const result = await run(
      { action: "track", message_id: "msg-bad", confidence: 0.9 },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Graph API 500");
  });
});
