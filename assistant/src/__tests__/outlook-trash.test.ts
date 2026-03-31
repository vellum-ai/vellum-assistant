import { describe, expect, mock, test } from "bun:test";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockTrashMessage = mock(() => Promise.resolve({}));
const mockResolveOAuthConnection = mock(() =>
  Promise.resolve({ id: "conn-1", providerKey: "outlook" }),
);

mock.module("../messaging/providers/outlook/client.js", () => ({
  trashMessage: mockTrashMessage,
}));

mock.module("../oauth/connection-resolver.js", () => ({
  resolveOAuthConnection: mockResolveOAuthConnection,
}));

import { run } from "../config/bundled-skills/outlook/tools/outlook-trash.js";
import type { ToolContext } from "../tools/types.js";

const ctx: ToolContext = {
  workingDir: "/tmp",
  conversationId: "test-conv",
  trustClass: "guardian",
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("outlook_trash tool", () => {
  test("returns error when message_id is missing", async () => {
    const result = await run({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("message_id is required");
  });

  test("moves message to Deleted Items", async () => {
    mockTrashMessage.mockClear();
    mockResolveOAuthConnection.mockClear();

    const result = await run({ message_id: "msg-123", confidence: 0.9 }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toBe("Message moved to Deleted Items.");
    expect(mockResolveOAuthConnection).toHaveBeenCalledWith("outlook", {
      account: undefined,
    });
    expect(mockTrashMessage).toHaveBeenCalledTimes(1);
  });

  test("passes account to connection resolver", async () => {
    mockResolveOAuthConnection.mockClear();

    await run(
      {
        message_id: "msg-456",
        account: "user@outlook.com",
        confidence: 0.8,
      },
      ctx,
    );

    expect(mockResolveOAuthConnection).toHaveBeenCalledWith("outlook", {
      account: "user@outlook.com",
    });
  });

  test("returns error on API failure", async () => {
    mockTrashMessage.mockImplementationOnce(() =>
      Promise.reject(new Error("Graph API 404: Not found")),
    );

    const result = await run({ message_id: "msg-bad", confidence: 0.9 }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Graph API 404");
  });
});
