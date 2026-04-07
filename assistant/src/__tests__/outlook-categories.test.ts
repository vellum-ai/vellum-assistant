import { describe, expect, mock, test } from "bun:test";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockGetMessage = mock(() =>
  Promise.resolve({ categories: ["Red category"] }),
);
const mockUpdateMessageCategories = mock(() => Promise.resolve());
const mockListMasterCategories = mock(() =>
  Promise.resolve({
    value: [
      { displayName: "Red category", color: "preset0" },
      { displayName: "Blue category", color: "preset7" },
    ],
  }),
);
const mockResolveOAuthConnection = mock(() =>
  Promise.resolve({ id: "conn-1", provider: "outlook" }),
);

mock.module("../messaging/providers/outlook/client.js", () => ({
  getMessage: mockGetMessage,
  updateMessageCategories: mockUpdateMessageCategories,
  listMasterCategories: mockListMasterCategories,
}));

mock.module("../oauth/connection-resolver.js", () => ({
  resolveOAuthConnection: mockResolveOAuthConnection,
}));

import { run } from "../config/bundled-skills/outlook/tools/outlook-categories.js";
import type { ToolContext } from "../tools/types.js";

const ctx: ToolContext = {
  workingDir: "/tmp",
  conversationId: "test-conv",
  trustClass: "guardian",
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("outlook_categories tool", () => {
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

  // ── add ──────────────────────────────────────────────────────────────────

  describe("add", () => {
    test("requires message_id", async () => {
      const result = await run(
        { action: "add", categories: ["Blue category"], confidence: 0.9 },
        ctx,
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("message_id is required");
    });

    test("requires categories", async () => {
      const result = await run(
        { action: "add", message_id: "msg-1", confidence: 0.9 },
        ctx,
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("categories is required");
    });

    test("merges new categories with existing", async () => {
      mockGetMessage.mockClear();
      mockUpdateMessageCategories.mockClear();
      mockGetMessage.mockImplementationOnce(() =>
        Promise.resolve({ categories: ["Red category"] }),
      );

      const result = await run(
        {
          action: "add",
          message_id: "msg-1",
          categories: ["Blue category"],
          confidence: 0.9,
        },
        ctx,
      );

      expect(result.isError).toBe(false);
      expect(result.content).toBe("Categories updated.");
      expect(mockUpdateMessageCategories).toHaveBeenCalledWith(
        expect.anything(),
        "msg-1",
        expect.arrayContaining(["Red category", "Blue category"]),
      );
    });

    test("deduplicates when adding existing category", async () => {
      mockGetMessage.mockClear();
      mockUpdateMessageCategories.mockClear();
      mockGetMessage.mockImplementationOnce(() =>
        Promise.resolve({ categories: ["Red category"] }),
      );

      await run(
        {
          action: "add",
          message_id: "msg-1",
          categories: ["Red category"],
          confidence: 0.9,
        },
        ctx,
      );

      const callArgs = mockUpdateMessageCategories.mock.calls[0] as unknown[];
      const calledCategories = callArgs[2] as string[];
      expect(calledCategories).toHaveLength(1);
      expect(calledCategories).toContain("Red category");
    });
  });

  // ── remove ───────────────────────────────────────────────────────────────

  describe("remove", () => {
    test("requires message_id", async () => {
      const result = await run(
        { action: "remove", categories: ["Red category"], confidence: 0.9 },
        ctx,
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("message_id is required");
    });

    test("requires categories", async () => {
      const result = await run(
        { action: "remove", message_id: "msg-1", confidence: 0.9 },
        ctx,
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("categories is required");
    });

    test("removes specified categories", async () => {
      mockGetMessage.mockClear();
      mockUpdateMessageCategories.mockClear();
      mockGetMessage.mockImplementationOnce(() =>
        Promise.resolve({ categories: ["Red category", "Blue category"] }),
      );

      const result = await run(
        {
          action: "remove",
          message_id: "msg-1",
          categories: ["Red category"],
          confidence: 0.9,
        },
        ctx,
      );

      expect(result.isError).toBe(false);
      expect(result.content).toBe("Categories updated.");
      expect(mockUpdateMessageCategories).toHaveBeenCalledWith(
        expect.anything(),
        "msg-1",
        ["Blue category"],
      );
    });
  });

  // ── list_available ───────────────────────────────────────────────────────

  describe("list_available", () => {
    test("returns available categories as JSON", async () => {
      mockListMasterCategories.mockClear();

      const result = await run(
        { action: "list_available", confidence: 0.5 },
        ctx,
      );

      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.content);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].displayName).toBe("Red category");
    });
  });

  // ── error handling ───────────────────────────────────────────────────────

  test("returns error on API failure", async () => {
    mockGetMessage.mockImplementationOnce(() =>
      Promise.reject(new Error("Graph API 403: Forbidden")),
    );

    const result = await run(
      {
        action: "add",
        message_id: "msg-bad",
        categories: ["Test"],
        confidence: 0.9,
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Graph API 403");
  });
});
