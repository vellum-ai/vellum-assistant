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

describe("assistant email register", () => {
  test("successful registration calls correct URL and body", async () => {
    mockFetch(
      "/email-addresses/",
      { method: "POST" },
      {
        body: {
          id: "550e8400-e29b-41d4-a716-446655440000",
          address: "mybot@vellum.me",
          created_at: "2026-04-04T21:00:00Z",
        },
        status: 201,
      },
    );

    await runAssistantCommand("email", "register", "mybot");

    const calls = getMockFetchCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe(
      `/v1/assistants/${ASSISTANT_ID}/email-addresses/`,
    );
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      username: "mybot",
    });
    expect(process.exitCode).toBe(0);
  });

  test("--json outputs structured response", async () => {
    mockFetch(
      "/email-addresses/",
      { method: "POST" },
      {
        body: {
          id: "550e8400-e29b-41d4-a716-446655440000",
          address: "support@vellum.me",
          created_at: "2026-04-04T21:00:00Z",
        },
        status: 201,
      },
    );

    const output = await runAssistantCommand(
      "email",
      "--json",
      "register",
      "support",
    );

    const parsed = JSON.parse(output.trim());
    expect(parsed.address).toBe("support@vellum.me");
    expect(parsed.id).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(parsed.created_at).toBe("2026-04-04T21:00:00Z");
    expect(process.exitCode).toBe(0);
  });

  test("duplicate address returns error", async () => {
    mockFetch(
      "/email-addresses/",
      { method: "POST" },
      {
        body: {
          assistant_id: ["This assistant already has an email address."],
        },
        status: 400,
      },
    );

    const output = await runAssistantCommand(
      "email",
      "--json",
      "register",
      "mybot",
    );

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("already has an email address");
  });

  test("missing platform credentials returns error", async () => {
    // Remove the API key so create() returns null
    _resetBackend();
    setPlatformAssistantId(undefined);

    const output = await runAssistantCommand(
      "email",
      "--json",
      "register",
      "mybot",
    );

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("Platform credentials not configured");
  });

  test("missing assistant ID returns error", async () => {
    setPlatformAssistantId("");

    const output = await runAssistantCommand(
      "email",
      "--json",
      "register",
      "mybot",
    );

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("Assistant ID");
  });

  test("platform 5xx returns error", async () => {
    mockFetch(
      "/email-addresses/",
      { method: "POST" },
      { body: { detail: "Internal server error" }, status: 500 },
    );

    const output = await runAssistantCommand(
      "email",
      "--json",
      "register",
      "mybot",
    );

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("Internal server error");
  });

  test("username validation error from platform is surfaced", async () => {
    mockFetch(
      "/email-addresses/",
      { method: "POST" },
      { body: { username: ["Enter a valid value."] }, status: 400 },
    );

    const output = await runAssistantCommand(
      "email",
      "--json",
      "register",
      "invalid username!",
    );

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("valid value");
  });
});
