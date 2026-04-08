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
const ADDRESS_ID = "550e8400-e29b-41d4-a716-446655440000";
const ADDRESS = "mybot@vellum.me";
const API_KEY_CREDENTIAL = credentialKey("vellum", "assistant_api_key");

function mockListAddresses(
  addresses: { id: string; address: string }[] = [
    { id: ADDRESS_ID, address: ADDRESS },
  ],
  status = 200,
): void {
  mockFetch("/email-addresses/", {}, { body: { results: addresses }, status });
}

function mockStatusSuccess(
  overrides?: Partial<{
    address: string;
    status: string;
    usage: { sent_today: number; daily_limit: number; received_today: number };
  }>,
): void {
  mockFetch(
    `/email-addresses/${ADDRESS_ID}/status/`,
    {},
    {
      body: {
        address: overrides?.address ?? ADDRESS,
        status: overrides?.status ?? "active",
        usage: overrides?.usage ?? {
          sent_today: 12,
          daily_limit: 100,
          received_today: 5,
        },
      },
      status: 200,
    },
  );
}

let savedCesUrl: string | undefined;
let savedContainerized: string | undefined;

beforeEach(async () => {
  process.exitCode = 0;

  // Force encrypted-store backend so setSecureKeyAsync works in sandbox
  savedCesUrl = process.env.CES_CREDENTIAL_URL;
  savedContainerized = process.env.IS_CONTAINERIZED;
  delete process.env.CES_CREDENTIAL_URL;
  delete process.env.IS_CONTAINERIZED;

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

  // Restore env
  if (savedCesUrl !== undefined) process.env.CES_CREDENTIAL_URL = savedCesUrl;
  else delete process.env.CES_CREDENTIAL_URL;
  if (savedContainerized !== undefined)
    process.env.IS_CONTAINERIZED = savedContainerized;
  else delete process.env.IS_CONTAINERIZED;
});

describe("assistant email status", () => {
  test("successful status shows address and usage", async () => {
    mockListAddresses();
    mockStatusSuccess();

    const output = await runAssistantCommand("email", "--json", "status");

    const parsed = JSON.parse(output.trim());
    expect(parsed.address).toBe(ADDRESS);
    expect(parsed.status).toBe("active");
    expect(parsed.usage.sent_today).toBe(12);
    expect(parsed.usage.daily_limit).toBe(100);
    expect(parsed.usage.received_today).toBe(5);
    expect(process.exitCode).toBe(0);
  });

  test("calls correct URLs in order", async () => {
    mockListAddresses();
    mockStatusSuccess();

    await runAssistantCommand("email", "--json", "status");

    const calls = getMockFetchCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0].path).toContain(
      `/v1/assistants/${ASSISTANT_ID}/email-addresses/`,
    );
    expect(calls[1].path).toContain(
      `/v1/assistants/${ASSISTANT_ID}/email-addresses/${ADDRESS_ID}/status/`,
    );
  });

  test("no registered address returns error", async () => {
    mockListAddresses([]);

    const output = await runAssistantCommand("email", "--json", "status");

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("No email address registered");
  });

  test("list endpoint failure returns error", async () => {
    mockFetch(
      "/email-addresses/",
      {},
      { body: { detail: "Internal server error" }, status: 500 },
    );

    const output = await runAssistantCommand("email", "--json", "status");

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("Failed to list email addresses");
  });

  test("status endpoint failure returns error", async () => {
    mockListAddresses();
    mockFetch(
      `/email-addresses/${ADDRESS_ID}/status/`,
      {},
      { body: { detail: "Service unavailable" }, status: 503 },
    );

    const output = await runAssistantCommand("email", "--json", "status");

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("Service unavailable");
  });

  test("missing platform credentials returns error", async () => {
    // Delete the API key so create() returns null
    await deleteSecureKeyAsync(API_KEY_CREDENTIAL);

    const output = await runAssistantCommand("email", "--json", "status");

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("Platform credentials not configured");
  });

  test("missing assistant ID returns error", async () => {
    setPlatformAssistantId("");

    const output = await runAssistantCommand("email", "--json", "status");

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("Assistant ID");
  });
});
