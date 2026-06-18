import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

interface MockPlatformClient {
  platformAssistantId: string;
  fetch: ReturnType<typeof mock>;
}

let mockClient: MockPlatformClient | null = null;

// Controls for classifyMissingClient() — only consulted when `create()` returns
// null. The credential-reachability classification now lives in `client.ts`
// behind `classifyMissingPlatformCredential()`, so we mock that seam directly.
// Defaults model a genuinely off-platform install with creds absent.
let mockCredentialAvailability: () => Promise<
  "absent" | "unreachable"
> = async () => "absent";

mock.module("../client.js", () => ({
  VellumPlatformClient: {
    create: async () => mockClient,
  },
  classifyMissingPlatformCredential: () => mockCredentialAvailability(),
}));

let mockPlatformEnabled = false;

mock.module("../feature-gate.js", () => ({
  arePlatformFeaturesEnabled: () => mockPlatformEnabled,
}));

import { fetchManagedProfiles } from "../managed-profiles.js";

function makeProfile(key: string, overrides: Record<string, unknown> = {}) {
  return {
    key,
    intent: "balanced",
    provider: "anthropic",
    connection_name: "default",
    source: "platform",
    label: `Label ${key}`,
    description: `Description ${key}`,
    max_tokens: 8192,
    effort: "medium",
    thinking: { enabled: true, stream_thinking: false },
    context_window: { max_input_tokens: 200000 },
    ...overrides,
  };
}

function okBody(schemaVersion = 1, count = 4) {
  return {
    schema_version: schemaVersion,
    profiles: Array.from({ length: count }, (_, i) => makeProfile(`p${i}`)),
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchManagedProfiles", () => {
  beforeEach(() => {
    mockClient = {
      platformAssistantId: "asst-123",
      fetch: mock(async () => jsonResponse(okBody())),
    };
    mockPlatformEnabled = false;
    mockCredentialAvailability = async () => "absent";
  });

  afterEach(() => {
    mockClient = null;
  });

  test("returns no-connection when platform features are disabled", async () => {
    mockClient = null;
    mockPlatformEnabled = false;
    expect(await fetchManagedProfiles()).toEqual({ status: "no-connection" });
  });

  test("returns no-connection when platform enabled but creds confirmed absent", async () => {
    mockClient = null;
    mockPlatformEnabled = true;
    mockCredentialAvailability = async () => "absent";
    expect(await fetchManagedProfiles()).toEqual({ status: "no-connection" });
  });

  test("returns error when platform enabled but credential read is unreachable", async () => {
    mockClient = null;
    mockPlatformEnabled = true;
    mockCredentialAvailability = async () => "unreachable";
    // A transient backend failure must preserve on-disk profiles, not prune.
    expect(await fetchManagedProfiles()).toEqual({ status: "error" });
  });

  test("returns error on an invalid intent (out-of-contract ModelIntent)", async () => {
    mockClient!.fetch = mock(async () =>
      jsonResponse({
        schema_version: 1,
        profiles: [makeProfile("p0", { intent: "general" })],
      }),
    );
    expect(await fetchManagedProfiles()).toEqual({ status: "error" });
  });

  test("returns error on an invalid provider", async () => {
    mockClient!.fetch = mock(async () =>
      jsonResponse({
        schema_version: 1,
        profiles: [makeProfile("p0", { provider: "claude" })],
      }),
    );
    expect(await fetchManagedProfiles()).toEqual({ status: "error" });
  });

  test("returns error on an invalid effort", async () => {
    mockClient!.fetch = mock(async () =>
      jsonResponse({
        schema_version: 1,
        profiles: [makeProfile("p0", { effort: "ultra" })],
      }),
    );
    expect(await fetchManagedProfiles()).toEqual({ status: "error" });
  });

  test("returns ok with parsed profiles on a valid 200", async () => {
    const result = await fetchManagedProfiles();
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.profiles).toHaveLength(4);
      expect(result.profiles[0].key).toBe("p0");
    }
    expect(mockClient!.fetch.mock.calls[0][0]).toBe(
      "/v1/assistants/asst-123/model-profiles/",
    );
  });

  test("returns error when assistant ID is missing", async () => {
    mockClient!.platformAssistantId = "";
    expect(await fetchManagedProfiles()).toEqual({ status: "error" });
    expect(mockClient!.fetch).not.toHaveBeenCalled();
  });

  test("returns error on HTTP 500", async () => {
    mockClient!.fetch = mock(async () => jsonResponse({}, 500));
    expect(await fetchManagedProfiles()).toEqual({ status: "error" });
  });

  test("returns error on malformed body", async () => {
    mockClient!.fetch = mock(async () =>
      jsonResponse({ profiles: [{ key: 123 }] }),
    );
    expect(await fetchManagedProfiles()).toEqual({ status: "error" });
  });

  test("returns error on unsupported schema_version", async () => {
    mockClient!.fetch = mock(async () => jsonResponse(okBody(2)));
    expect(await fetchManagedProfiles()).toEqual({ status: "error" });
  });

  test("returns error when the fetch throws / aborts", async () => {
    mockClient!.fetch = mock(async () => {
      throw new DOMException("aborted", "AbortError");
    });
    expect(await fetchManagedProfiles()).toEqual({ status: "error" });
  });
});
