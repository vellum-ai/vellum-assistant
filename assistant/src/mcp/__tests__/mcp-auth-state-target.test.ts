import { describe, expect, test } from "bun:test";

import {
  getMcpAuthState,
  setMcpAuthComplete,
  setMcpAuthError,
  setMcpAuthPending,
} from "../mcp-auth-state.js";

describe("MCP auth state target identity", () => {
  test("does not return state for a different endpoint target", () => {
    const serverId = "target-filter-server";
    setMcpAuthPending(
      serverId,
      "https://auth.example.com",
      "attempt-a",
      "key-a",
    );

    expect(getMcpAuthState(serverId, "key-b")).toBeNull();
    expect(getMcpAuthState(serverId, "key-a")?.status).toBe("pending");
  });

  test("a stale endpoint tail cannot overwrite a newer target", () => {
    const serverId = "target-supersede-server";
    setMcpAuthPending(
      serverId,
      "https://auth-a.example.com",
      "attempt-a",
      "key-a",
    );
    setMcpAuthPending(
      serverId,
      "https://auth-b.example.com",
      "attempt-b",
      "key-b",
    );

    expect(setMcpAuthComplete(serverId, "attempt-a", "key-a")).toBe(false);
    expect(
      setMcpAuthError(serverId, "stale failure", "attempt-a", "key-a"),
    ).toBe(false);
    expect(getMcpAuthState(serverId, "key-b")).toMatchObject({
      status: "pending",
      attemptId: "attempt-b",
      targetKey: "key-b",
    });
  });
});
