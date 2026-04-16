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
  deleteSecureKeyAsync,
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

describe("assistant domain register", () => {
  test("successful registration with explicit subdomain", async () => {
    mockFetch(
      "/domains/",
      { method: "POST" },
      {
        body: {
          id: "550e8400-e29b-41d4-a716-446655440000",
          domain: "becky.vellum.me",
          status: "active",
          verified: true,
          created_at: "2026-04-15T19:00:00Z",
        },
        status: 201,
      },
    );

    await runAssistantCommand("domain", "register", "becky");

    const calls = getMockFetchCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toContain(`/v1/assistants/${ASSISTANT_ID}/domains/`);
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      subdomain: "becky",
    });
    expect(process.exitCode).toBe(0);
  });

  test("registration without subdomain sends empty body", async () => {
    mockFetch(
      "/domains/",
      { method: "POST" },
      {
        body: {
          id: "550e8400-e29b-41d4-a716-446655440000",
          domain: "my-assistant.vellum.me",
          status: "active",
          verified: true,
          created_at: "2026-04-15T19:00:00Z",
        },
        status: 201,
      },
    );

    await runAssistantCommand("domain", "register");

    const calls = getMockFetchCalls();
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({});
    expect(process.exitCode).toBe(0);
  });

  test("--json outputs structured response", async () => {
    mockFetch(
      "/domains/",
      { method: "POST" },
      {
        body: {
          id: "550e8400-e29b-41d4-a716-446655440000",
          domain: "becky.vellum.me",
          status: "active",
          verified: true,
          created_at: "2026-04-15T19:00:00Z",
        },
        status: 201,
      },
    );

    const output = await runAssistantCommand(
      "domain",
      "--json",
      "register",
      "becky",
    );

    const parsed = JSON.parse(output.trim());
    expect(parsed.domain).toBe("becky.vellum.me");
    expect(parsed.verified).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  test("duplicate domain returns error", async () => {
    mockFetch(
      "/domains/",
      { method: "POST" },
      {
        body: {
          detail: "This assistant already has a registered domain.",
        },
        status: 400,
      },
    );

    const output = await runAssistantCommand(
      "domain",
      "--json",
      "register",
      "becky",
    );

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("already has a registered domain");
  });

  test("subdomain validation error is surfaced", async () => {
    mockFetch(
      "/domains/",
      { method: "POST" },
      {
        body: { subdomain: ["Enter a valid value."] },
        status: 400,
      },
    );

    const output = await runAssistantCommand(
      "domain",
      "--json",
      "register",
      "invalid subdomain!",
    );

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("valid value");
  });

  test("missing platform credentials returns error", async () => {
    await deleteSecureKeyAsync(API_KEY_CREDENTIAL);

    const output = await runAssistantCommand(
      "domain",
      "--json",
      "register",
      "velly",
    );

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("Platform credentials not configured");
  });

  test("missing assistant ID returns error", async () => {
    setPlatformAssistantId("");

    const output = await runAssistantCommand(
      "domain",
      "--json",
      "register",
      "becky",
    );

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("Assistant ID");
  });

  test("platform 5xx returns error", async () => {
    mockFetch(
      "/domains/",
      { method: "POST" },
      { body: { detail: "Internal server error" }, status: 500 },
    );

    const output = await runAssistantCommand(
      "domain",
      "--json",
      "register",
      "becky",
    );

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("Internal server error");
  });

  test("unverified domain shows warning", async () => {
    mockFetch(
      "/domains/",
      { method: "POST" },
      {
        body: {
          id: "550e8400-e29b-41d4-a716-446655440000",
          domain: "becky.vellum.me",
          status: "pending",
          verified: false,
          created_at: "2026-04-15T19:00:00Z",
        },
        status: 201,
      },
    );

    // Just verify it doesn't crash — the warning goes to stderr/log
    await runAssistantCommand("domain", "register", "becky");
    expect(process.exitCode).toBe(0);
  });
});
