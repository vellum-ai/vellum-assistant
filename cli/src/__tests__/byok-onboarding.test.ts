/**
 * Tests for `applyByokOnboarding` — the CLI helper that turns the recipe
 * returned by `GET /v1/inference/onboarding-templates/:provider` into a
 * sequence of writes against the existing public endpoints.
 *
 * Stubs `fetch` to capture every call. Assertions inspect URL + method +
 * body so we cover the contract between the CLI and the assistant without
 * spinning up a real assistant.
 */

import { describe, expect, test } from "bun:test";

import { applyByokOnboarding } from "../lib/byok-onboarding.js";
import type { ProviderSecretFetch } from "../lib/provider-secrets.js";

interface RecordedFetchCall {
  url: string;
  method: string;
  body: unknown;
  authorization: string | null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function getHeader(init: RequestInit | undefined, name: string): string | null {
  const headers = init?.headers as
    | Record<string, string>
    | Headers
    | undefined;
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  const lowered = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return lowered[name.toLowerCase()] ?? null;
}

function makeFetch(responses: Response[]): {
  calls: RecordedFetchCall[];
  fetchImpl: ProviderSecretFetch;
} {
  const calls: RecordedFetchCall[] = [];
  const fetchImpl: ProviderSecretFetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: String(init?.method ?? "GET"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
      authorization: getHeader(init, "Authorization"),
    });
    const response = responses.shift();
    if (!response) throw new Error("Unexpected fetch call.");
    return response;
  };
  return { calls, fetchImpl };
}

const SAMPLE_RECIPE = {
  provider: "anthropic",
  personalConnection: {
    name: "anthropic-personal",
    provider: "anthropic",
    label: "Anthropic (Personal)",
    auth: { type: "api_key", credential: "anthropic.api_key" },
    status: "active",
  },
  managedConnectionsToDisable: [
    { name: "anthropic-managed", auth: { type: "platform" }, status: "disabled" },
    { name: "openai-managed", auth: { type: "platform" }, status: "disabled" },
  ],
  managedProfilesToDisable: ["balanced", "quality-optimized", "cost-optimized"],
  userProfiles: {
    "custom-balanced": {
      provider: "anthropic",
      provider_connection: "anthropic-personal",
      model: "claude-sonnet-4-6",
      label: "Balanced",
      source: "user",
    },
    "custom-quality-optimized": {
      provider: "anthropic",
      provider_connection: "anthropic-personal",
      model: "claude-opus-4-7",
      label: "Quality",
      source: "user",
    },
  },
  activeProfile: "custom-balanced",
  profileOrder: [
    "balanced",
    "quality-optimized",
    "cost-optimized",
    "custom-balanced",
    "custom-quality-optimized",
  ],
};

function makeOkResponses(count: number, recipe = SAMPLE_RECIPE): Response[] {
  // First response is the GET recipe; the rest are `{ok: true}` write
  // acknowledgements from PATCH/PUT/POST handlers.
  return [
    jsonResponse(recipe),
    ...Array.from({ length: count - 1 }, () => jsonResponse({ ok: true })),
  ];
}

describe("applyByokOnboarding", () => {
  test("walks the recipe in the documented order with auth on every call", async () => {
    // 1 GET + 1 POST(connection) + 2 PATCH(connection) + 3 PUT(disable profile)
    // + 2 PUT(user profile) + 2 POST(config/set) = 11
    const { calls, fetchImpl } = makeFetch(makeOkResponses(11));

    await applyByokOnboarding({
      gatewayUrl: "http://localhost:3000",
      provider: "anthropic",
      bearerToken: "test-token",
      fetchImpl,
    });

    // Step 1: GET recipe.
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe(
      "http://localhost:3000/v1/inference/onboarding-templates/anthropic",
    );

    // Step 2: POST personal connection (body matches recipe.personalConnection).
    expect(calls[1]!.method).toBe("POST");
    expect(calls[1]!.url).toBe(
      "http://localhost:3000/v1/inference/provider-connections",
    );
    expect(calls[1]!.body).toEqual(SAMPLE_RECIPE.personalConnection);

    // Step 3: PATCH each managed connection.
    expect(calls[2]!.method).toBe("PATCH");
    expect(calls[2]!.url).toBe(
      "http://localhost:3000/v1/inference/provider-connections/anthropic-managed",
    );
    expect(calls[2]!.body).toEqual({
      auth: { type: "platform" },
      status: "disabled",
    });
    expect(calls[3]!.method).toBe("PATCH");
    expect(calls[3]!.url).toContain("/openai-managed");

    // Step 4: PUT managed profiles to disabled.
    expect(calls[4]!.method).toBe("PUT");
    expect(calls[4]!.url).toBe(
      "http://localhost:3000/v1/config/llm/profiles/balanced",
    );
    expect(calls[4]!.body).toEqual({ status: "disabled" });
    expect(calls[5]!.url).toContain("/quality-optimized");
    expect(calls[6]!.url).toContain("/cost-optimized");

    // Step 5: PUT each user profile (full ProfileEntry body).
    expect(calls[7]!.method).toBe("PUT");
    expect(calls[7]!.url).toBe(
      "http://localhost:3000/v1/config/llm/profiles/custom-balanced",
    );
    expect(calls[7]!.body).toEqual(SAMPLE_RECIPE.userProfiles["custom-balanced"]);
    expect(calls[8]!.url).toContain("/custom-quality-optimized");

    // Step 6 + 7: POST config/set for activeProfile + profileOrder.
    expect(calls[9]!.method).toBe("POST");
    expect(calls[9]!.url).toBe("http://localhost:3000/v1/config/set");
    expect(calls[9]!.body).toEqual({
      path: "llm.activeProfile",
      value: "custom-balanced",
    });
    expect(calls[10]!.method).toBe("POST");
    expect(calls[10]!.body).toEqual({
      path: "llm.profileOrder",
      value: SAMPLE_RECIPE.profileOrder,
    });

    // Every call carries the bearer token.
    for (const call of calls) {
      expect(call.authorization).toBe("Bearer test-token");
    }
  });

  test("treats 409 on personal-connection create as idempotent success", async () => {
    // Step 1 OK (GET), step 2 returns 409 (already exists), rest OK.
    const responses = [
      jsonResponse(SAMPLE_RECIPE),
      jsonResponse({ error: "Connection already exists" }, 409),
      ...Array.from({ length: 9 }, () => jsonResponse({ ok: true })),
    ];
    const { calls, fetchImpl } = makeFetch(responses);

    await applyByokOnboarding({
      gatewayUrl: "http://localhost:3000",
      provider: "anthropic",
      bearerToken: "test-token",
      fetchImpl,
    });

    // All 11 steps still executed despite the 409 mid-flow.
    expect(calls.length).toBe(11);
  });

  test("treats 404 on managed connection PATCH as idempotent success", async () => {
    // managedConnectionsToDisable has 2 entries; first 404s (catalog moved
    // and that connection isn't seeded), second succeeds. Setup should
    // continue through to the final POST.
    const responses = [
      jsonResponse(SAMPLE_RECIPE),
      jsonResponse({ ok: true }), // POST personal
      jsonResponse({ error: "Not found" }, 404), // PATCH anthropic-managed
      jsonResponse({ ok: true }), // PATCH openai-managed
      ...Array.from({ length: 7 }, () => jsonResponse({ ok: true })),
    ];
    const { calls, fetchImpl } = makeFetch(responses);

    await applyByokOnboarding({
      gatewayUrl: "http://localhost:3000",
      provider: "anthropic",
      bearerToken: "test-token",
      fetchImpl,
    });

    expect(calls.length).toBe(11);
  });

  test("throws if recipe GET fails", async () => {
    const responses = [
      jsonResponse({ error: "Unknown provider" }, 400),
    ];
    const { fetchImpl } = makeFetch(responses);

    await expect(
      applyByokOnboarding({
        gatewayUrl: "http://localhost:3000",
        provider: "anthropic",
        bearerToken: "test-token",
        fetchImpl,
      }),
    ).rejects.toThrow(/Failed to fetch BYOK onboarding templates/);
  });

  test("throws if a non-409 personal-connection error comes back", async () => {
    const responses = [
      jsonResponse(SAMPLE_RECIPE),
      jsonResponse({ error: "Invalid auth" }, 400),
    ];
    const { fetchImpl } = makeFetch(responses);

    await expect(
      applyByokOnboarding({
        gatewayUrl: "http://localhost:3000",
        provider: "anthropic",
        bearerToken: "test-token",
        fetchImpl,
      }),
    ).rejects.toThrow(/Failed to create personal provider connection/);
  });

  test("validates recipe shape before applying any writes", async () => {
    // Server returned 200 but the body is missing fields. The CLI shouldn't
    // start writing then bail half-way — it should reject up front.
    const responses = [
      jsonResponse({ provider: "anthropic" }), // missing every other key
    ];
    const { calls, fetchImpl } = makeFetch(responses);

    await expect(
      applyByokOnboarding({
        gatewayUrl: "http://localhost:3000",
        provider: "anthropic",
        bearerToken: "test-token",
        fetchImpl,
      }),
    ).rejects.toThrow(/missing required field/);
    // Only the GET happened; no writes were issued.
    expect(calls.length).toBe(1);
  });
});
