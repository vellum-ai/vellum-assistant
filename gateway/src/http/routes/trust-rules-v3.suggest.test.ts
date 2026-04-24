/**
 * Tests for POST /v1/trust-rules-v3/suggest handler.
 *
 * Uses bun:test mock.module to stub ipcSuggestTrustRule, and initializes
 * a real in-memory SQLite DB (via initGatewayDb) for threshold reads.
 * The `permission-controls-v3` feature flag is toggled via writeFeatureFlag.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import "../../__tests__/test-preload.js";

// ---------------------------------------------------------------------------
// Mocks — must be registered before importing the handler under test
// ---------------------------------------------------------------------------

const ipcSuggestTrustRuleMock = mock(
  (_params: unknown) =>
    Promise.resolve({
      pattern: "git push",
      risk: "medium",
      description: "Allow git push",
      scopeOptions: [{ pattern: "git push", label: "This exact command" }],
    }),
);

mock.module("../../ipc/assistant-client.js", () => ({
  ipcSuggestTrustRule: ipcSuggestTrustRuleMock,
}));

// Import after mocks are registered
const { createTrustRuleV3SuggestHandler } = await import(
  "./trust-rules-v3.js"
);

import { initGatewayDb, resetGatewayDb } from "../../db/connection.js";
import {
  writeFeatureFlag,
  clearFeatureFlagStoreCache,
} from "../../feature-flag-store.js";
import { getGatewayDb } from "../../db/connection.js";
import { autoApproveThresholds } from "../../db/schema.js";

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  resetGatewayDb();
  clearFeatureFlagStoreCache();
  await initGatewayDb();

  // Clear persisted threshold rows so each test starts from a clean state.
  // resetGatewayDb() closes the connection but the SQLite file retains data.
  getGatewayDb().delete(autoApproveThresholds).run();

  // Enable the feature flag for all tests by default
  writeFeatureFlag("permission-controls-v3", true);

  // Reset mock state
  ipcSuggestTrustRuleMock.mockReset();
  ipcSuggestTrustRuleMock.mockImplementation((_params: unknown) =>
    Promise.resolve({
      pattern: "git push",
      risk: "medium",
      description: "Allow git push",
      scopeOptions: [{ pattern: "git push", label: "This exact command" }],
    }),
  );
});

afterEach(() => {
  clearFeatureFlagStoreCache();
  resetGatewayDb();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_BODY = {
  tool: "bash",
  command: "git push origin main",
  riskAssessment: {
    risk: "medium",
    reasoning: "Pushes code to remote",
    reasonDescription: "This command pushes commits to a remote repository",
  },
  scopeOptions: [
    { pattern: "git push", label: "Any git push" },
    { pattern: "git push origin main", label: "This exact command" },
  ],
  intent: "auto_approve" as const,
};

function jsonRequest(body?: unknown): Request {
  return new Request("http://localhost/v1/trust-rules-v3/suggest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /v1/trust-rules-v3/suggest", () => {
  test("returns 403 when permission-controls-v3 flag is off", async () => {
    writeFeatureFlag("permission-controls-v3", false);

    const handler = createTrustRuleV3SuggestHandler();
    const res = await handler(jsonRequest(VALID_BODY));

    expect(res.status).toBe(403);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe("Feature not enabled");
  });

  test("returns 400 when body is not valid JSON", async () => {
    const handler = createTrustRuleV3SuggestHandler();
    const req = new Request("http://localhost/v1/trust-rules-v3/suggest", {
      method: "POST",
      body: "not json {{{{",
    });
    const res = await handler(req);

    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("valid JSON");
  });

  test("returns 400 when intent field is missing", async () => {
    const handler = createTrustRuleV3SuggestHandler();
    const { intent: _omitted, ...bodyWithoutIntent } = VALID_BODY;
    const res = await handler(jsonRequest(bodyWithoutIntent));

    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string; issues: unknown[] };
    expect(data.error).toBe("Invalid request body");
    expect(data.issues.length).toBeGreaterThan(0);
  });

  test("returns 400 when intent value is invalid", async () => {
    const handler = createTrustRuleV3SuggestHandler();
    const res = await handler(
      jsonRequest({ ...VALID_BODY, intent: "approve_forever" }),
    );

    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string; issues: unknown[] };
    expect(data.error).toBe("Invalid request body");
  });

  test("returns 400 when required string fields are missing", async () => {
    const handler = createTrustRuleV3SuggestHandler();

    // Missing tool
    const res1 = await handler(
      jsonRequest({ ...VALID_BODY, tool: undefined }),
    );
    expect(res1.status).toBe(400);

    // Missing command
    const res2 = await handler(
      jsonRequest({ ...VALID_BODY, command: undefined }),
    );
    expect(res2.status).toBe(400);
  });

  test("returns 503 when ipcSuggestTrustRule throws", async () => {
    ipcSuggestTrustRuleMock.mockImplementation(() => {
      throw new Error("assistant is unreachable");
    });

    const handler = createTrustRuleV3SuggestHandler();
    const res = await handler(jsonRequest(VALID_BODY));

    expect(res.status).toBe(503);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("assistant is unreachable");
  });

  test("returns 200 with suggestion on success", async () => {
    const mockSuggestion = {
      pattern: "git push origin main",
      risk: "medium",
      description: "Allow pushing to main branch",
      scopeOptions: [
        { pattern: "git push", label: "Any git push" },
        { pattern: "git push origin main", label: "This exact command" },
      ],
    };
    ipcSuggestTrustRuleMock.mockImplementation(() =>
      Promise.resolve(mockSuggestion),
    );

    const handler = createTrustRuleV3SuggestHandler();
    const res = await handler(jsonRequest(VALID_BODY));

    expect(res.status).toBe(200);
    const data = (await res.json()) as { suggestion: typeof mockSuggestion };
    expect(data.suggestion).toEqual(mockSuggestion);
  });

  test("passes currentThreshold from DB to ipcSuggestTrustRule", async () => {
    // Write a threshold row with interactive = "medium"
    const db = getGatewayDb();
    db.insert(autoApproveThresholds)
      .values({ id: 1, interactive: "medium", background: "high", headless: "none" })
      .onConflictDoUpdate({
        target: autoApproveThresholds.id,
        set: { interactive: "medium" },
      })
      .run();

    const handler = createTrustRuleV3SuggestHandler();
    await handler(jsonRequest(VALID_BODY));

    expect(ipcSuggestTrustRuleMock).toHaveBeenCalledTimes(1);
    const callArgs = ipcSuggestTrustRuleMock.mock.calls[0][0] as {
      currentThreshold: string;
    };
    expect(callArgs.currentThreshold).toBe("medium");
  });

  test("currentThreshold defaults to 'low' when no threshold row in DB", async () => {
    // No row inserted — DB is fresh from beforeEach
    const handler = createTrustRuleV3SuggestHandler();
    await handler(jsonRequest(VALID_BODY));

    expect(ipcSuggestTrustRuleMock).toHaveBeenCalledTimes(1);
    const callArgs = ipcSuggestTrustRuleMock.mock.calls[0][0] as {
      currentThreshold: string;
    };
    expect(callArgs.currentThreshold).toBe("low");
  });

  test("passes directoryScopeOptions when provided", async () => {
    const bodyWithDirScope = {
      ...VALID_BODY,
      directoryScopeOptions: [
        { scope: "/home/user/project", label: "Current project" },
      ],
    };

    const handler = createTrustRuleV3SuggestHandler();
    const res = await handler(jsonRequest(bodyWithDirScope));

    expect(res.status).toBe(200);
    expect(ipcSuggestTrustRuleMock).toHaveBeenCalledTimes(1);
    const callArgs = ipcSuggestTrustRuleMock.mock.calls[0][0] as {
      directoryScopeOptions: unknown;
    };
    expect(callArgs.directoryScopeOptions).toEqual([
      { scope: "/home/user/project", label: "Current project" },
    ]);
  });
});
