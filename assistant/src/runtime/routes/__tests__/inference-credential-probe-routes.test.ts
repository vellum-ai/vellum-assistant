/**
 * Tests for POST /v1/inference/provider-connections/:name/probe-model-access.
 *
 * The probe exists to distinguish "the key is dead" from "the key is alive
 * but this project cannot reach the model", so the cases below assert those
 * two verdicts stay distinguishable, and that a connection with no stored
 * provider credential is reported as unprobeable rather than broken.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  ModelAccessProbeRequest,
  ModelAccessProbeResult,
} from "@vellumai/credential-storage";

import { setConfig } from "../../../__tests__/helpers/set-config.js";
import { getDb } from "../../../persistence/db-connection.js";
import { initializeDb } from "../../../persistence/db-init.js";
import { providerConnections } from "../../../persistence/schema/inference.js";

let probeCalls: ModelAccessProbeRequest[] = [];
let probeResult: ModelAccessProbeResult | null = null;

mock.module("../../../security/secure-keys.js", () => ({
  probeModelAccessAsync: async (request: ModelAccessProbeRequest) => {
    probeCalls.push(request);
    return probeResult;
  },
}));

const { handleProbeModelAccess } =
  await import("../inference-credential-probe-routes.js");
const { NotFoundError } = await import("../errors.js");

await initializeDb();

function seedConnection(opts: {
  name: string;
  provider: string;
  auth: object;
  baseUrl?: string;
}): void {
  const now = Date.now();
  getDb()
    .insert(providerConnections)
    .values({
      name: opts.name,
      provider: opts.provider,
      auth: JSON.stringify(opts.auth),
      ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function seedGeminiSetup(): void {
  seedConnection({
    name: "gemini-personal",
    provider: "gemini",
    auth: { type: "api_key", credential: "credential/gemini-personal/api_key" },
  });
  setConfig("llm", {
    profiles: {
      fast: {
        provider: "gemini",
        model: "gemini-3.1-flash-lite",
        provider_connection: "gemini-personal",
      },
    },
  });
}

beforeEach(() => {
  getDb().delete(providerConnections).run();
  setConfig("llm", {});
  probeCalls = [];
  probeResult = null;
});

describe("probe model access", () => {
  test("GIVEN a stored key that cannot reach the profile's model WHEN probing THEN it reports the model as not accessible", async () => {
    seedGeminiSetup();
    probeResult = {
      outcome: "valid",
      status: 200,
      accessibleModels: ["models/gemini-2.5-flash"],
      models: [{ model: "gemini-3.1-flash-lite", access: "not_accessible" }],
    };

    const result = await handleProbeModelAccess({
      pathParams: { name: "gemini-personal" },
    });

    expect(result.outcome).toBe("valid");
    expect(result.models).toEqual([
      {
        model: "gemini-3.1-flash-lite",
        access: "not_accessible",
        profiles: ["fast"],
      },
    ]);
    expect(result.summary).toContain("gemini-3.1-flash-lite");
    expect(result.summary).toContain("cannot access");
  });

  test("GIVEN the connection's profiles WHEN probing THEN their models are checked with the connection's credential account", async () => {
    seedGeminiSetup();
    probeResult = {
      outcome: "valid",
      accessibleModels: [],
      models: [{ model: "gemini-3.1-flash-lite", access: "accessible" }],
    };

    await handleProbeModelAccess({ pathParams: { name: "gemini-personal" } });

    expect(probeCalls).toHaveLength(1);
    expect(probeCalls[0]).toEqual({
      account: "credential/gemini-personal/api_key",
      request: {
        url: "https://generativelanguage.googleapis.com/v1beta/models",
        credentialInjection: { kind: "header", name: "x-goog-api-key" },
      },
      models: ["gemini-3.1-flash-lite"],
    });
  });

  test("GIVEN explicit models WHEN probing THEN they override the profile-derived list", async () => {
    seedGeminiSetup();
    probeResult = {
      outcome: "valid",
      accessibleModels: [],
      models: [{ model: "gemini-2.5-pro", access: "accessible" }],
    };

    const result = await handleProbeModelAccess({
      pathParams: { name: "gemini-personal" },
      body: { models: ["gemini-2.5-pro"] },
    });

    expect(probeCalls[0]?.models).toEqual(["gemini-2.5-pro"]);
    expect(result.models[0]?.profiles).toEqual([]);
  });

  test("GIVEN a rejected credential WHEN probing THEN the outcome is invalid", async () => {
    seedGeminiSetup();
    probeResult = {
      outcome: "invalid",
      status: 401,
      detail: "API key not valid",
      accessibleModels: [],
      models: [{ model: "gemini-3.1-flash-lite", access: "unknown" }],
    };

    const result = await handleProbeModelAccess({
      pathParams: { name: "gemini-personal" },
    });

    expect(result.outcome).toBe("invalid");
    expect(result.status).toBe(401);
    expect(result.summary).toContain("rejected by the provider");
  });

  test("GIVEN a platform-authenticated connection WHEN probing THEN it is reported as unsupported without calling the store", async () => {
    seedConnection({
      name: "vellum",
      provider: "anthropic",
      auth: { type: "platform" },
    });

    const result = await handleProbeModelAccess({
      pathParams: { name: "vellum" },
    });

    expect(result.outcome).toBe("unsupported");
    expect(probeCalls).toHaveLength(0);
  });

  test("GIVEN a subscription connection WHEN probing THEN it is reported as unsupported, since inference refreshes the stored token before use", async () => {
    seedConnection({
      name: "chatgpt-subscription",
      provider: "openai",
      auth: {
        type: "oauth_subscription",
        credential: "credential/chatgpt/access_token",
      },
    });

    const result = await handleProbeModelAccess({
      pathParams: { name: "chatgpt-subscription" },
    });

    expect(result.outcome).toBe("unsupported");
    expect(result.summary).toContain("refreshed at inference time");
    expect(probeCalls).toHaveLength(0);
  });

  test("GIVEN an unreachable credential store WHEN probing THEN the outcome is inconclusive", async () => {
    seedGeminiSetup();
    probeResult = null;

    const result = await handleProbeModelAccess({
      pathParams: { name: "gemini-personal" },
    });

    expect(result.outcome).toBe("inconclusive");
    expect(result.models[0]?.access).toBe("unknown");
  });

  test("GIVEN an unknown connection WHEN probing THEN it 404s", async () => {
    await expect(
      handleProbeModelAccess({ pathParams: { name: "nope" } }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
