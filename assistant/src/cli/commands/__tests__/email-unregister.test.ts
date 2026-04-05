import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  getMockFetchCalls,
  mockFetch,
  resetMockFetch,
} from "../../../__tests__/mock-fetch.js";
import { _setOverridesForTesting } from "../../../config/assistant-feature-flags.js";
import {
  _setCreateOverrideForTesting,
  VellumPlatformClient,
} from "../../../platform/client.js";
import { runAssistantCommand } from "../../__tests__/run-assistant-command.js";

const ASSISTANT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const ADDRESS_ID = "550e8400-e29b-41d4-a716-446655440000";
const ADDRESS = "mybot@vellum.me";

function setClient(
  overrides?: Partial<{
    platformAssistantId: string;
  }> | null,
): void {
  if (overrides === null) {
    _setCreateOverrideForTesting(async () => null);
    return;
  }
  const assistantId = overrides?.platformAssistantId ?? ASSISTANT_ID;
  _setCreateOverrideForTesting(async () =>
    VellumPlatformClient.fromCredentials(
      "" /* base URL — mockFetch intercepts before it matters */,
      "test-api-key",
      assistantId,
    ),
  );
}

beforeEach(() => {
  process.exitCode = 0;
  resetMockFetch();
  _setOverridesForTesting({ "email-channel": true });
  setClient();
});

afterEach(() => {
  resetMockFetch();
  _setOverridesForTesting({});
  _setCreateOverrideForTesting(undefined);
});

function standardEmailMockFetches(
  deleteStatus = 204,
  deleteBody: unknown = null,
): void {
  mockFetch(
    "/email-addresses/",
    {},
    {
      body: { results: [{ id: ADDRESS_ID, address: ADDRESS }] },
      status: 200,
    },
  );
  mockFetch(
    `/email-addresses/${ADDRESS_ID}/`,
    { method: "DELETE" },
    { body: deleteBody, status: deleteStatus },
  );
}

describe("assistant email unregister", () => {
  test("successful unregister with --confirm lists then deletes", async () => {
    standardEmailMockFetches();

    await runAssistantCommand("email", "unregister", "--confirm");

    const calls = getMockFetchCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0].path).toBe(
      `/v1/assistants/${ASSISTANT_ID}/email-addresses/`,
    );
    expect(calls[1].path).toBe(
      `/v1/assistants/${ASSISTANT_ID}/email-addresses/${ADDRESS_ID}/`,
    );
    expect(calls[1].init.method).toBe("DELETE");
    expect(process.exitCode).toBe(0);
  });

  test("--json outputs structured response", async () => {
    standardEmailMockFetches();

    const output = await runAssistantCommand("email", "--json", "unregister");

    const parsed = JSON.parse(output.trim());
    expect(parsed.unregistered).toBe(ADDRESS);
    expect(process.exitCode).toBe(0);
  });

  test("no registered address returns error", async () => {
    mockFetch("/email-addresses/", {}, { body: { results: [] }, status: 200 });

    const output = await runAssistantCommand("email", "--json", "unregister");

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

    const output = await runAssistantCommand("email", "--json", "unregister");

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("Failed to list email addresses");
  });

  test("delete endpoint failure returns error", async () => {
    standardEmailMockFetches(500, { detail: "Cannot delete address" });

    const output = await runAssistantCommand("email", "--json", "unregister");

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("Cannot delete address");
  });

  test("missing platform credentials returns error", async () => {
    setClient(null);

    const output = await runAssistantCommand("email", "--json", "unregister");

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("Platform credentials not configured");
  });

  test("missing assistant ID returns error", async () => {
    setClient({ platformAssistantId: "" });

    const output = await runAssistantCommand("email", "--json", "unregister");

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("Assistant ID");
  });
});
