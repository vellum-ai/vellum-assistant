import { describe, test, expect, beforeEach, mock } from "bun:test";

import { findGuardianForChannelActor } from "../auth/guardian-bootstrap.js";

// Mock the IPC proxy — returns rows for specific queries
const mockQuery = mock();
mock.module("../db/assistant-db-proxy.js", () => ({
  assistantDbQuery: mockQuery,
  assistantDbRun: mock(),
  assistantDbExec: mock(),
}));

beforeEach(() => {
  mockQuery.mockReset();
});

describe("findGuardianForChannelActor", () => {
  test("returns null when no binding exists", async () => {
    mockQuery.mockResolvedValue([]);
    expect(await findGuardianForChannelActor("slack", "U_UNKNOWN")).toBeNull();
  });

  test("returns principalId for an active slack guardian binding", async () => {
    mockQuery.mockResolvedValue([
      { contact_id: "guardian-001", principal_id: "principal-owner" },
    ]);

    const result = await findGuardianForChannelActor("slack", "U_OWNER");
    expect(result).not.toBeNull();
    expect(result?.principalId).toBe("principal-owner");
  });

  test("returns null when the query returns a row without principal_id", async () => {
    mockQuery.mockResolvedValue([
      { contact_id: "guardian-001", principal_id: null },
    ]);

    expect(await findGuardianForChannelActor("slack", "U_REVOKED")).toBeNull();
  });

  test("returns null for empty inputs", async () => {
    expect(await findGuardianForChannelActor("", "U_OWNER")).toBeNull();
    expect(await findGuardianForChannelActor("slack", "")).toBeNull();
    // Should not even call the proxy for empty inputs
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
