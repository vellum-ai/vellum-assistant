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
const PLATFORM_BASE_URL_CREDENTIAL = credentialKey("vellum", "platform_base_url");
const PLATFORM_ASSISTANT_ID_CREDENTIAL = credentialKey(
  "vellum",
  "platform_assistant_id",
);

/**
 * Platform API calls made against the configured platform base URL. Filters
 * out auxiliary fetches (feature-flag sync to the gateway) that are performed
 * during CLI bootstrap and aren't relevant to these tests.
 */
function getPlatformCalls(): ReturnType<typeof getMockFetchCalls> {
  return getMockFetchCalls().filter((c) =>
    c.path.startsWith("https://test-platform.vellum.ai/"),
  );
}

function mockListAddresses(
  addresses: { id: string; address: string }[] = [
    { id: ADDRESS_ID, address: ADDRESS },
  ],
  status = 200,
): void {
  mockFetch("/email-addresses/", {}, { body: { results: addresses }, status });
}

function mockSendSuccess(deliveryId = "del_abc123", status = 202): void {
  mockFetch(
    "/runtime-proxy/email/send/",
    { method: "POST" },
    { body: { delivery_id: deliveryId, status: "accepted" }, status },
  );
}

beforeEach(async () => {
  process.exitCode = 0;
  _resetBackend();
  // Ensure we don't inherit platform credentials from prior test files that
  // persist to ~/.vellum/protected/keys.enc on disk.
  await deleteSecureKeyAsync(API_KEY_CREDENTIAL);
  await deleteSecureKeyAsync(PLATFORM_BASE_URL_CREDENTIAL);
  await deleteSecureKeyAsync(PLATFORM_ASSISTANT_ID_CREDENTIAL);
  resetMockFetch();
  _setOverridesForTesting({ "email-channel": true });
  setPlatformAssistantId(ASSISTANT_ID);
  await setSecureKeyAsync(API_KEY_CREDENTIAL, "test-api-key");
});

afterEach(async () => {
  resetMockFetch();
  _setOverridesForTesting({});
  setPlatformAssistantId(undefined);
  await deleteSecureKeyAsync(API_KEY_CREDENTIAL);
  await deleteSecureKeyAsync(PLATFORM_BASE_URL_CREDENTIAL);
  await deleteSecureKeyAsync(PLATFORM_ASSISTANT_ID_CREDENTIAL);
  _resetBackend();
});

describe("assistant email send", () => {
  test("successful send with --body and --subject", async () => {
    mockListAddresses();
    mockSendSuccess();

    await runAssistantCommand(
      "email",
      "send",
      "user@example.com",
      "-s",
      "Hello",
      "-b",
      "Hi there",
    );

    const calls = getPlatformCalls();
    expect(calls).toHaveLength(2);

    // First call: list addresses to resolve "from"
    expect(calls[0].path).toContain(
      `/v1/assistants/${ASSISTANT_ID}/email-addresses/`,
    );

    // Second call: send via runtime proxy
    expect(calls[1].path).toContain("/v1/runtime-proxy/email/send/");
    expect(calls[1].init.method).toBe("POST");

    const payload = JSON.parse(calls[1].init.body as string);
    expect(payload.to).toBe("user@example.com");
    expect(payload.from_address).toBe(ADDRESS);
    expect(payload.subject).toBe("Hello");
    expect(payload.text).toBe("Hi there");

    expect(process.exitCode).toBe(0);
  });

  test("--json outputs structured response", async () => {
    mockListAddresses();
    mockSendSuccess("del_xyz789");

    const output = await runAssistantCommand(
      "email",
      "--json",
      "send",
      "user@example.com",
      "-s",
      "Test",
      "-b",
      "Body",
    );

    const parsed = JSON.parse(output.trim());
    expect(parsed.delivery_id).toBe("del_xyz789");
    expect(parsed.status).toBe("accepted");
    expect(process.exitCode).toBe(0);
  });

  test("no registered address returns error", async () => {
    mockListAddresses([]);

    const output = await runAssistantCommand(
      "email",
      "--json",
      "send",
      "user@example.com",
      "-s",
      "Hello",
      "-b",
      "Body",
    );

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("No email address registered");
  });

  test("missing body returns error", async () => {
    // Force isTTY to true so stdin fallback is skipped
    const origIsTTY = process.stdin.isTTY;
    process.stdin.isTTY = true as unknown as boolean;

    mockListAddresses();

    const output = await runAssistantCommand(
      "email",
      "--json",
      "send",
      "user@example.com",
      "-s",
      "Hello",
    );

    process.stdin.isTTY = origIsTTY;

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("Email body is required");
  });

  test("send endpoint failure surfaces error detail", async () => {
    mockListAddresses();
    mockFetch(
      "/runtime-proxy/email/send/",
      { method: "POST" },
      {
        body: { detail: "From address not owned by this assistant." },
        status: 403,
      },
    );

    const output = await runAssistantCommand(
      "email",
      "--json",
      "send",
      "user@example.com",
      "-s",
      "Hello",
      "-b",
      "Body",
    );

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("not owned by this assistant");
  });

  test("list addresses failure returns error", async () => {
    mockFetch(
      "/email-addresses/",
      {},
      { body: { detail: "Internal server error" }, status: 500 },
    );

    const output = await runAssistantCommand(
      "email",
      "--json",
      "send",
      "user@example.com",
      "-s",
      "Hello",
      "-b",
      "Body",
    );

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("Failed to list email addresses");
  });

  test("missing platform credentials returns error", async () => {
    // Remove the API key so VellumPlatformClient.create() returns null.
    await deleteSecureKeyAsync(API_KEY_CREDENTIAL);
    _resetBackend();
    setPlatformAssistantId(undefined);

    const output = await runAssistantCommand(
      "email",
      "--json",
      "send",
      "user@example.com",
      "-s",
      "Hello",
      "-b",
      "Body",
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
      "send",
      "user@example.com",
      "-s",
      "Hello",
      "-b",
      "Body",
    );

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("Assistant ID");
  });

  test("send without subject omits subject from payload", async () => {
    mockListAddresses();
    mockSendSuccess();

    await runAssistantCommand(
      "email",
      "send",
      "user@example.com",
      "-b",
      "Body only, no subject",
    );

    const calls = getPlatformCalls();
    const payload = JSON.parse(calls[1].init.body as string);
    expect(payload.subject).toBeUndefined();
    expect(payload.text).toBe("Body only, no subject");
    expect(process.exitCode).toBe(0);
  });

  test("suppressed recipient error is surfaced", async () => {
    mockListAddresses();
    mockFetch(
      "/runtime-proxy/email/send/",
      { method: "POST" },
      {
        body: {
          detail:
            "Recipient user@example.com is suppressed due to prior bounce or spam complaint.",
        },
        status: 422,
      },
    );

    const output = await runAssistantCommand(
      "email",
      "--json",
      "send",
      "user@example.com",
      "-s",
      "Hello",
      "-b",
      "Body",
    );

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("suppressed");
  });
});
