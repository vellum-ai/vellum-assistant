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
const ASSISTANT_ID_CREDENTIAL = credentialKey(
  "vellum",
  "platform_assistant_id",
);

/**
 * Return the recorded fetch calls, excluding the feature-flag fetch that
 * `buildCliProgram()` issues on startup — tests here care about the email
 * API calls, not that bootstrap fetch.
 */
function getEmailApiCalls(): { path: string; init: RequestInit }[] {
  return getMockFetchCalls().filter(
    (c) => !c.path.includes("/v1/feature-flags"),
  );
}

const SAMPLE_MESSAGES = [
  {
    id: "msg-001",
    direction: "inbound",
    from_address: "user@example.com",
    to_addresses: ["mybot@vellum.me"],
    subject: "Hello bot",
    created_at: "2026-04-05T12:00:00Z",
  },
  {
    id: "msg-002",
    direction: "outbound",
    from_address: "mybot@vellum.me",
    to_addresses: ["user@example.com"],
    subject: "Re: Hello bot",
    created_at: "2026-04-05T12:01:00Z",
  },
];

function mockListEmails(
  results = SAMPLE_MESSAGES,
  count?: number,
  status = 200,
): void {
  mockFetch(
    "/emails/",
    {},
    { body: { results, count: count ?? results.length }, status },
  );
}

let savedCesUrl: string | undefined;
let savedContainerized: string | undefined;

beforeEach(async () => {
  process.exitCode = 0;

  savedCesUrl = process.env.CES_CREDENTIAL_URL;
  savedContainerized = process.env.IS_CONTAINERIZED;
  delete process.env.CES_CREDENTIAL_URL;
  delete process.env.IS_CONTAINERIZED;

  _resetBackend();
  resetMockFetch();
  // Mock the feature-flag fetch that buildCliProgram() performs on startup so
  // it doesn't hit a real URL and so tests remain deterministic.
  mockFetch(
    "/v1/feature-flags",
    {},
    { body: { flags: [{ key: "email-channel", enabled: true }] }, status: 200 },
  );
  _setOverridesForTesting({ "email-channel": true });
  setPlatformAssistantId(ASSISTANT_ID);
  await setSecureKeyAsync(API_KEY_CREDENTIAL, "test-api-key");
  // Ensure VellumPlatformClient.create() cannot fall back to a real
  // platform_assistant_id from the encrypted credential store on dev
  // machines — the "missing assistant ID" test relies on the fallback
  // lookup returning empty.
  await deleteSecureKeyAsync(ASSISTANT_ID_CREDENTIAL);
});

afterEach(() => {
  resetMockFetch();
  _setOverridesForTesting({});
  setPlatformAssistantId(undefined);
  _resetBackend();

  if (savedCesUrl !== undefined) process.env.CES_CREDENTIAL_URL = savedCesUrl;
  else delete process.env.CES_CREDENTIAL_URL;
  if (savedContainerized !== undefined)
    process.env.IS_CONTAINERIZED = savedContainerized;
  else delete process.env.IS_CONTAINERIZED;
});

describe("assistant email list", () => {
  test("--json returns messages and count", async () => {
    mockListEmails();

    const output = await runAssistantCommand("email", "--json", "list");

    const parsed = JSON.parse(output.trim());
    expect(parsed.results).toHaveLength(2);
    expect(parsed.count).toBe(2);
    expect(parsed.results[0].subject).toBe("Hello bot");
    expect(parsed.results[1].direction).toBe("outbound");
    expect(process.exitCode).toBe(0);
  });

  test("calls correct URL with no filters", async () => {
    mockListEmails();

    await runAssistantCommand("email", "--json", "list");

    const calls = getEmailApiCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toContain(`/v1/assistants/${ASSISTANT_ID}/emails/`);
    // Default limit=20 should be in query string
    expect(calls[0].path).toContain("limit=20");
  });

  test("--direction filters by direction", async () => {
    mockListEmails();

    await runAssistantCommand(
      "email",
      "--json",
      "list",
      "--direction",
      "inbound",
    );

    const calls = getEmailApiCalls();
    expect(calls[0].path).toContain("direction=inbound");
  });

  test("--limit sets result count", async () => {
    mockListEmails();

    await runAssistantCommand("email", "--json", "list", "--limit", "5");

    const calls = getEmailApiCalls();
    expect(calls[0].path).toContain("limit=5");
  });

  test("--since filters by date", async () => {
    mockListEmails();

    await runAssistantCommand(
      "email",
      "--json",
      "list",
      "--since",
      "2026-04-01",
    );

    const calls = getEmailApiCalls();
    expect(calls[0].path).toContain("since=2026-04-01");
  });

  test("empty results returns empty array", async () => {
    mockListEmails([], 0);

    const output = await runAssistantCommand("email", "--json", "list");

    const parsed = JSON.parse(output.trim());
    expect(parsed.results).toHaveLength(0);
    expect(parsed.count).toBe(0);
    expect(process.exitCode).toBe(0);
  });

  test("endpoint failure returns error", async () => {
    mockFetch(
      "/emails/",
      {},
      { body: { detail: "Internal server error" }, status: 500 },
    );

    const output = await runAssistantCommand("email", "--json", "list");

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("Internal server error");
  });

  test("missing platform credentials returns error", async () => {
    await deleteSecureKeyAsync(API_KEY_CREDENTIAL);

    const output = await runAssistantCommand("email", "--json", "list");

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("Platform credentials not configured");
  });

  test("missing assistant ID returns error", async () => {
    setPlatformAssistantId("");

    const output = await runAssistantCommand("email", "--json", "list");

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("Assistant ID");
  });
});
