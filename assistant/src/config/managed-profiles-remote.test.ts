import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mutable mock state
// ---------------------------------------------------------------------------

let mockDisableRemote = false;
let mockClient: {
  platformAssistantId: string;
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
} | null = null;
let lastFetchPath: string | undefined;
// When set, `VellumPlatformClient.create()` returns this promise instead of
// resolving to `mockClient`. Lets a test simulate a slow/hung credential
// subsystem inside `create()`.
let mockCreate: (() => Promise<unknown>) | undefined;

// ---------------------------------------------------------------------------
// Module mocks (must be registered before importing the module under test)
// ---------------------------------------------------------------------------

mock.module("./env-registry.js", () => ({
  getDisableRemoteModelProfiles: () => mockDisableRemote,
}));

mock.module("../platform/client.js", () => ({
  VellumPlatformClient: {
    create: () => (mockCreate ? mockCreate() : Promise.resolve(mockClient)),
  },
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import { fetchManagedProfileTemplates } from "./managed-profiles-remote.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function remoteProfile(overrides: Record<string, unknown> = {}) {
  return {
    key: "balanced",
    intent: "balanced",
    provider: "anthropic",
    connection_name: "anthropic-managed",
    source: "managed",
    label: "Balanced",
    description: "Good balance",
    max_tokens: 16000,
    effort: "high",
    thinking: { enabled: true, stream_thinking: true },
    context_window: { max_input_tokens: 200000 },
    ...overrides,
  };
}

function fourValidProfiles() {
  return [
    remoteProfile({ key: "balanced", intent: "balanced" }),
    remoteProfile({ key: "quality-optimized", intent: "quality-optimized" }),
    remoteProfile({
      key: "cost-optimized",
      intent: "latency-optimized",
      effort: "low",
      max_tokens: 8192,
      thinking: { enabled: false, stream_thinking: false },
    }),
    remoteProfile({
      key: "balanced-economy",
      provider: "fireworks",
      connection_name: "fireworks-managed",
    }),
  ];
}

function makeClient(response: () => Response | Promise<Response>) {
  return {
    platformAssistantId: "asst-123",
    fetch: mock(async (path: string) => {
      lastFetchPath = path;
      return response();
    }),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fetchManagedProfileTemplates", () => {
  beforeEach(() => {
    mockDisableRemote = false;
    mockClient = null;
    lastFetchPath = undefined;
    mockCreate = undefined;
  });

  afterEach(() => {
    mockClient = null;
    mockCreate = undefined;
  });

  test("happy path: maps 4 valid profiles with camelCase keys", async () => {
    mockClient = makeClient(() =>
      jsonResponse({ schema_version: 1, profiles: fourValidProfiles() }),
    );

    const result = await fetchManagedProfileTemplates();

    expect(result).not.toBeNull();
    expect(Object.keys(result!).sort()).toEqual([
      "balanced",
      "balanced-economy",
      "cost-optimized",
      "quality-optimized",
    ]);

    const balanced = result!.balanced;
    expect(balanced.connectionName).toBe("anthropic-managed");
    expect(balanced.maxTokens).toBe(16000);
    expect(balanced.effort).toBe("high");
    expect(balanced.thinking!.streamThinking).toBe(true);
    expect(balanced.contextWindow!.maxInputTokens).toBe(200000);
    expect(balanced.intent).toBe("balanced");
    expect(balanced.provider).toBe("anthropic");
    expect(balanced.source).toBe("managed");

    const cost = result!["cost-optimized"];
    expect(cost.intent).toBe("latency-optimized");
    expect(cost.thinking!.streamThinking).toBe(false);
    expect(cost.maxTokens).toBe(8192);

    const economy = result!["balanced-economy"];
    expect(economy.provider).toBe("fireworks");
    expect(economy.connectionName).toBe("fireworks-managed");

    expect(lastFetchPath).toBe("/v1/assistants/asst-123/model-profiles/");
  });

  test("kill-switch set → null, no fetch attempted", async () => {
    mockDisableRemote = true;
    mockClient = makeClient(() =>
      jsonResponse({ schema_version: 1, profiles: fourValidProfiles() }),
    );

    const result = await fetchManagedProfileTemplates();

    expect(result).toBeNull();
    expect(mockClient.fetch).not.toHaveBeenCalled();
  });

  test("platform client null (disabled / missing prereqs) → null", async () => {
    mockClient = null;
    const result = await fetchManagedProfileTemplates();
    expect(result).toBeNull();
  });

  test("client with empty assistant id → null", async () => {
    mockClient = {
      platformAssistantId: "",
      fetch: mock(async () =>
        jsonResponse({ schema_version: 1, profiles: [] }),
      ),
    };
    const result = await fetchManagedProfileTemplates();
    expect(result).toBeNull();
    expect(mockClient.fetch).not.toHaveBeenCalled();
  });

  test("HTTP 500 / non-ok → null", async () => {
    mockClient = makeClient(() => jsonResponse({ error: "boom" }, 500));
    const result = await fetchManagedProfileTemplates();
    expect(result).toBeNull();
  });

  test("network throw / timeout → null", async () => {
    mockClient = makeClient(() => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    const result = await fetchManagedProfileTemplates();
    expect(result).toBeNull();
  });

  test("malformed body (missing field) → null", async () => {
    const broken = fourValidProfiles();
    delete (broken[0] as Record<string, unknown>).connection_name;
    mockClient = makeClient(() =>
      jsonResponse({ schema_version: 1, profiles: broken }),
    );
    const result = await fetchManagedProfileTemplates();
    expect(result).toBeNull();
  });

  test("malformed body (bad enum) → null", async () => {
    const broken = [remoteProfile({ intent: "not-a-real-intent" })];
    mockClient = makeClient(() =>
      jsonResponse({ schema_version: 1, profiles: broken }),
    );
    const result = await fetchManagedProfileTemplates();
    expect(result).toBeNull();
  });

  test("schema_version: 2 → null", async () => {
    mockClient = makeClient(() =>
      jsonResponse({ schema_version: 2, profiles: fourValidProfiles() }),
    );
    const result = await fetchManagedProfileTemplates();
    expect(result).toBeNull();
  });

  test("unknown profile key not in MANAGED_PROFILE_NAMES → null", async () => {
    const profiles = [
      remoteProfile({ key: "balanced" }),
      remoteProfile({ key: "totally-new-key" }),
    ];
    mockClient = makeClient(() =>
      jsonResponse({ schema_version: 1, profiles }),
    );
    const result = await fetchManagedProfileTemplates();
    expect(result).toBeNull();
  });

  test("empty profiles array → null (wholesale fallback)", async () => {
    mockClient = makeClient(() =>
      jsonResponse({ schema_version: 1, profiles: [] }),
    );
    const result = await fetchManagedProfileTemplates();
    expect(result).toBeNull();
  });

  test("partial-but-valid subset (missing a known key) → null", async () => {
    const profiles = fourValidProfiles().slice(0, 3);
    mockClient = makeClient(() =>
      jsonResponse({ schema_version: 1, profiles }),
    );
    const result = await fetchManagedProfileTemplates();
    expect(result).toBeNull();
  });

  test("alternate canonical provider/connection pairing (gemini) → accepted", async () => {
    // The platform may legitimately roll a managed key to another managed
    // provider. gemini-managed + gemini is a canonical pairing and must pass.
    const profiles = fourValidProfiles();
    (profiles[0] as Record<string, unknown>).provider = "gemini";
    (profiles[0] as Record<string, unknown>).connection_name = "gemini-managed";
    mockClient = makeClient(() =>
      jsonResponse({ schema_version: 1, profiles }),
    );
    const result = await fetchManagedProfileTemplates();
    expect(result).not.toBeNull();
    expect(result!.balanced.provider).toBe("gemini");
    expect(result!.balanced.connectionName).toBe("gemini-managed");
  });

  test("alternate canonical provider/connection pairing (openai) → accepted", async () => {
    const profiles = fourValidProfiles();
    (profiles[0] as Record<string, unknown>).provider = "openai";
    (profiles[0] as Record<string, unknown>).connection_name = "openai-managed";
    mockClient = makeClient(() =>
      jsonResponse({ schema_version: 1, profiles }),
    );
    const result = await fetchManagedProfileTemplates();
    expect(result).not.toBeNull();
    expect(result!.balanced.provider).toBe("openai");
    expect(result!.balanced.connectionName).toBe("openai-managed");
  });

  test("source: 'user' → null (remote managed profiles must stay managed)", async () => {
    const profiles = fourValidProfiles();
    (profiles[0] as Record<string, unknown>).source = "user";
    mockClient = makeClient(() =>
      jsonResponse({ schema_version: 1, profiles }),
    );
    const result = await fetchManagedProfileTemplates();
    expect(result).toBeNull();
  });

  test("connection_name not in MANAGED_CONNECTION_NAMES → null", async () => {
    const profiles = fourValidProfiles();
    (profiles[0] as Record<string, unknown>).connection_name =
      "anthropic-managd";
    mockClient = makeClient(() =>
      jsonResponse({ schema_version: 1, profiles }),
    );
    const result = await fetchManagedProfileTemplates();
    expect(result).toBeNull();
  });

  test("canonical connection but mismatched provider → null", async () => {
    const profiles = fourValidProfiles();
    // anthropic-managed is a canonical connection, but it belongs to the
    // "anthropic" provider, not "openai".
    (profiles[0] as Record<string, unknown>).provider = "openai";
    mockClient = makeClient(() =>
      jsonResponse({ schema_version: 1, profiles }),
    );
    const result = await fetchManagedProfileTemplates();
    expect(result).toBeNull();
  });

  test("genuine mismatch on alternate connection (gemini-managed + openai) → null", async () => {
    const profiles = fourValidProfiles();
    (profiles[0] as Record<string, unknown>).provider = "openai";
    (profiles[0] as Record<string, unknown>).connection_name = "gemini-managed";
    mockClient = makeClient(() =>
      jsonResponse({ schema_version: 1, profiles }),
    );
    const result = await fetchManagedProfileTemplates();
    expect(result).toBeNull();
  });

  test("client creation hangs → null within budget, does not throw", async () => {
    // Simulate a slow/unreachable credential subsystem: create() never
    // resolves within the budget. The whole operation must still fall back to
    // null bounded by the timeout, not by create()'s ~45s internal timeout.
    mockCreate = () => new Promise(() => {});

    const start = Date.now();
    const result = await fetchManagedProfileTemplates({ timeoutMs: 50 });
    const elapsed = Date.now() - start;

    expect(result).toBeNull();
    // Generous upper bound to stay deterministic on a loaded CI box while still
    // proving we did NOT wait for create()'s internal timeout.
    expect(elapsed).toBeLessThan(2000);
  });

  test("late client-creation rejection does not produce an unhandled rejection", async () => {
    // create() rejects AFTER the timeout has already won the race. The losing
    // promise must be handled so the late rejection can't crash the process.
    mockCreate = () =>
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error("late CES failure")), 30);
      });

    const result = await fetchManagedProfileTemplates({ timeoutMs: 5 });
    expect(result).toBeNull();
    // Give the late rejection time to fire so an unhandled rejection would
    // surface within this test rather than leaking to another.
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});
