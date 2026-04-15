import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  getMockFetchCalls,
  mockFetch,
  resetMockFetch,
} from "../../../__tests__/mock-fetch.js";
import { _setOverridesForTesting } from "../../../config/assistant-feature-flags.js";
import { setPlatformAssistantId } from "../../../config/env.js";
import { credentialKey } from "../../../security/credential-key.js";
import {
  _resetBackend,
  setSecureKeyAsync,
} from "../../../security/secure-keys.js";
import { runAssistantCommand } from "../../__tests__/run-assistant-command.js";

const ASSISTANT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const API_KEY_CREDENTIAL = credentialKey("vellum", "assistant_api_key");

beforeEach(async () => {
  process.exitCode = 0;
  _resetBackend();
  resetMockFetch();
  _setOverridesForTesting({ "email-channel": true });
  setPlatformAssistantId(ASSISTANT_ID);
  await setSecureKeyAsync(API_KEY_CREDENTIAL, "test-api-key");
});

afterEach(() => {
  resetMockFetch();
  _setOverridesForTesting({});
  setPlatformAssistantId(undefined);
  _resetBackend();
});

describe("assistant domain status", () => {
  test("shows domain info when registered", async () => {
    mockFetch(
      "/domains/",
      {},
      {
        body: {
          results: [
            {
              id: "550e8400-e29b-41d4-a716-446655440000",
              domain: "becky.vellum.me",
              status: "active",
              verified: true,
              created_at: "2026-04-15T19:00:00Z",
            },
          ],
        },
        status: 200,
      },
    );

    await runAssistantCommand("domain", "status");

    const calls = getMockFetchCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe(`/v1/assistants/${ASSISTANT_ID}/domains/`);
    expect(calls[0].init.method).toBeUndefined();
    expect(process.exitCode).toBe(0);
  });

  test("--json outputs structured response", async () => {
    mockFetch(
      "/domains/",
      {},
      {
        body: {
          results: [
            {
              id: "550e8400-e29b-41d4-a716-446655440000",
              domain: "becky.vellum.me",
              status: "active",
              verified: true,
              created_at: "2026-04-15T19:00:00Z",
            },
          ],
        },
        status: 200,
      },
    );

    const output = await runAssistantCommand("domain", "--json", "status");

    const parsed = JSON.parse(output.trim());
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].domain).toBe("becky.vellum.me");
    expect(process.exitCode).toBe(0);
  });

  test("no domain registered shows helpful message", async () => {
    mockFetch(
      "/domains/",
      {},
      {
        body: { results: [] },
        status: 200,
      },
    );

    await runAssistantCommand("domain", "status");
    expect(process.exitCode).toBe(0);
  });

  test("missing platform credentials returns error", async () => {
    _resetBackend();
    setPlatformAssistantId(undefined);

    const output = await runAssistantCommand("domain", "--json", "status");

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("Platform credentials not configured");
  });

  test("platform error is surfaced", async () => {
    mockFetch(
      "/domains/",
      {},
      { body: { detail: "Service unavailable" }, status: 503 },
    );

    const output = await runAssistantCommand("domain", "--json", "status");

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("Service unavailable");
  });
});
