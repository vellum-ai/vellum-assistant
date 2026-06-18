import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

interface MockPlatformClient {
  platformAssistantId: string;
  fetch: ReturnType<typeof mock>;
}

let mockClient: MockPlatformClient | null = null;

mock.module("../client.js", () => ({
  VellumPlatformClient: {
    create: async () => mockClient,
  },
}));

import { fetchManagedProfiles } from "../managed-profiles.js";

function makeProfile(key: string) {
  return {
    key,
    intent: "general",
    provider: "anthropic",
    connection_name: "default",
    source: "platform",
    label: `Label ${key}`,
    description: `Description ${key}`,
    max_tokens: 8192,
    effort: "medium",
    thinking: { enabled: true, stream_thinking: false },
    context_window: { max_input_tokens: 200000 },
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
  });

  afterEach(() => {
    mockClient = null;
  });

  test("returns no-connection when no platform client", async () => {
    mockClient = null;
    expect(await fetchManagedProfiles()).toEqual({ status: "no-connection" });
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
