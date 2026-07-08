/**
 * Tests for the default-provider route handlers.
 *
 * Covers:
 *   GET /v1/config/llm/default-provider — availability per provider kind,
 *     connection/credential states, CES-unreachable vs missing-credential
 *   PUT /v1/config/llm/default-provider — strict validation, persistence
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Module mocks (must come before imports) ──────────────────────────────────

let fakeConfig: Record<string, unknown> = {};
let savedRawConfig: Record<string, unknown> | null = null;
mock.module("../../../config/loader.js", () => ({
  getConfigReadOnly: () => fakeConfig,
  getConfig: () => fakeConfig,
  loadRawConfig: () => fakeConfig,
  saveRawConfig: (config: Record<string, unknown>) => {
    savedRawConfig = config;
  },
  invalidateConfigCache: () => {},
}));

let managedProxyEnabled = false;
let managedProxyBaseUrl = "https://platform.example";
mock.module("../../../providers/platform-proxy/context.js", () => ({
  resolveManagedProxyContext: async () => ({
    enabled: managedProxyEnabled,
    platformBaseUrl: managedProxyBaseUrl,
    assistantApiKey: managedProxyEnabled ? "key" : "",
  }),
}));

let secureKeyResults: Record<
  string,
  { value: string | undefined; unreachable: boolean }
> = {};
mock.module("../../../security/secure-keys.js", () => ({
  getSecureKeyResultAsync: async (account: string) =>
    secureKeyResults[account] ?? { value: undefined, unreachable: false },
}));

// ── Real imports (after mocks) ────────────────────────────────────────────────

import { getDb } from "../../../persistence/db-connection.js";
import { initializeDb } from "../../../persistence/db-init.js";
import { providerConnections } from "../../../persistence/schema/inference.js";
import { ROUTES } from "../default-provider-routes.js";
import { BadRequestError } from "../errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "../types.js";

// ── DB bootstrap ──────────────────────────────────────────────────────────────

await initializeDb();

// ── Helpers ───────────────────────────────────────────────────────────────────

function findRoute(operationId: string): RouteDefinition {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`Route ${operationId} not found`);
  }
  return route;
}

async function get(): Promise<Record<string, unknown>> {
  return (await findRoute("llm_default_provider_get").handler({})) as Record<
    string,
    unknown
  >;
}

async function put(body: RouteHandlerArgs["body"]): Promise<unknown> {
  return await findRoute("llm_default_provider_put").handler({ body });
}

function availability(result: Record<string, unknown>): {
  status: string;
  message?: string;
} {
  return result.availability as { status: string; message?: string };
}

function seedConnection(opts: {
  name: string;
  provider: string;
  auth: object;
}): void {
  const now = Date.now();
  getDb()
    .insert(providerConnections)
    .values({
      name: opts.name,
      provider: opts.provider,
      auth: JSON.stringify(opts.auth),
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  getDb().delete(providerConnections).run();
  fakeConfig = { llm: {} };
  savedRawConfig = null;
  managedProxyEnabled = false;
  managedProxyBaseUrl = "https://platform.example";
  secureKeyResults = {};
});

// ── GET ───────────────────────────────────────────────────────────────────────

describe("GET config/llm/default-provider", () => {
  test("no default configured → missing_default", async () => {
    const result = await get();
    expect(result.provider).toBeNull();
    expect(result.resolvedConnectionName).toBeNull();
    expect(availability(result).status).toBe("missing_default");
    expect(availability(result).message).toContain("default provider");
  });

  test("vellum + authenticated → ok", async () => {
    fakeConfig = { llm: { defaultProvider: { provider: "vellum" } } };
    managedProxyEnabled = true;
    const result = await get();
    expect(result.provider).toBe("vellum");
    expect(availability(result)).toEqual({ status: "ok" });
  });

  test("vellum + unauthenticated → vellum_unauthenticated naming the fix", async () => {
    fakeConfig = { llm: { defaultProvider: { provider: "vellum" } } };
    const result = await get();
    expect(availability(result).status).toBe("vellum_unauthenticated");
    expect(availability(result).message).toContain("Log in");
  });

  test("vellum + no platform URL → vellum_unauthenticated naming the URL", async () => {
    fakeConfig = { llm: { defaultProvider: { provider: "vellum" } } };
    managedProxyBaseUrl = "";
    const result = await get();
    expect(availability(result).status).toBe("vellum_unauthenticated");
    expect(availability(result).message).toContain("platform URL");
  });

  test("BYOK with stored key → ok, convention-resolved connection", async () => {
    seedConnection({
      name: "anthropic-personal",
      provider: "anthropic",
      auth: { type: "api_key", credential: "credential/anthropic/api_key" },
    });
    secureKeyResults["credential/anthropic/api_key"] = {
      value: "sk-ant",
      unreachable: false,
    };
    fakeConfig = { llm: { defaultProvider: { provider: "anthropic" } } };

    const result = await get();
    expect(result.resolvedConnectionName).toBe("anthropic-personal");
    expect(result.connectionName).toBeUndefined();
    expect(availability(result)).toEqual({ status: "ok" });
  });

  test("explicit connectionName wins over convention", async () => {
    seedConnection({
      name: "work-openai",
      provider: "openai",
      auth: { type: "none" },
    });
    fakeConfig = {
      llm: {
        defaultProvider: { provider: "openai", connectionName: "work-openai" },
      },
    };

    const result = await get();
    expect(result.connectionName).toBe("work-openai");
    expect(result.resolvedConnectionName).toBe("work-openai");
    expect(availability(result)).toEqual({ status: "ok" });
  });

  test("no connection row → missing_connection naming connection and provider", async () => {
    fakeConfig = { llm: { defaultProvider: { provider: "openai" } } };
    const result = await get();
    expect(availability(result).status).toBe("missing_connection");
    expect(availability(result).message).toContain('"openai-personal"');
    expect(availability(result).message).toContain('"openai"');
  });

  test("api_key connection with no stored key → missing_credential", async () => {
    seedConnection({
      name: "anthropic-personal",
      provider: "anthropic",
      auth: { type: "api_key", credential: "credential/anthropic/api_key" },
    });
    fakeConfig = { llm: { defaultProvider: { provider: "anthropic" } } };

    const result = await get();
    expect(availability(result).status).toBe("missing_credential");
    expect(availability(result).message).toContain("API key");
    expect(availability(result).message).toContain('"anthropic-personal"');
  });

  test("credential store unreachable → unknown, never missing_credential", async () => {
    seedConnection({
      name: "anthropic-personal",
      provider: "anthropic",
      auth: { type: "api_key", credential: "credential/anthropic/api_key" },
    });
    secureKeyResults["credential/anthropic/api_key"] = {
      value: undefined,
      unreachable: true,
    };
    fakeConfig = { llm: { defaultProvider: { provider: "anthropic" } } };

    const result = await get();
    expect(availability(result).status).toBe("unknown");
    expect(availability(result).message).toContain("unreachable");
  });

  test("platform-auth connection follows managed-proxy state", async () => {
    seedConnection({
      name: "anthropic-personal",
      provider: "anthropic",
      auth: { type: "platform" },
    });
    fakeConfig = { llm: { defaultProvider: { provider: "anthropic" } } };

    expect(availability(await get()).status).toBe("vellum_unauthenticated");
    managedProxyEnabled = true;
    expect(availability(await get()).status).toBe("ok");
  });
});

// ── PUT ───────────────────────────────────────────────────────────────────────

describe("PUT config/llm/default-provider", () => {
  test("valid body persists and returns fresh status", async () => {
    seedConnection({
      name: "openai-personal",
      provider: "openai",
      auth: { type: "none" },
    });

    const result = (await put({ provider: "openai" })) as Record<
      string,
      unknown
    >;

    expect(
      (savedRawConfig?.llm as Record<string, unknown>).defaultProvider,
    ).toEqual({ provider: "openai" });
    expect(result.provider).toBe("openai");
    expect(availability(result)).toEqual({ status: "ok" });
  });

  test("persists an explicit connectionName", async () => {
    await put({ provider: "openai", connectionName: "work-openai" });
    expect(
      (savedRawConfig?.llm as Record<string, unknown>).defaultProvider,
    ).toEqual({ provider: "openai", connectionName: "work-openai" });
  });

  test("dangling connection is accepted and reported via availability", async () => {
    const result = (await put({ provider: "gemini" })) as Record<
      string,
      unknown
    >;
    expect(savedRawConfig).not.toBeNull();
    expect(availability(result).status).toBe("missing_connection");
  });

  test("invalid provider → 400 naming the allowed providers", async () => {
    const err = await put({ provider: "not-a-provider" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BadRequestError);
    expect((err as BadRequestError).message).toContain("anthropic");
    expect((err as BadRequestError).message).toContain("vellum");
    expect(savedRawConfig).toBeNull();
  });

  test("unknown keys are stripped from the persisted value", async () => {
    await put({ provider: "anthropic", extra: "nope" });
    expect(
      (savedRawConfig?.llm as Record<string, unknown>).defaultProvider,
    ).toEqual({ provider: "anthropic" });
  });
});

// ── Route policy ──────────────────────────────────────────────────────────────

describe("route policy", () => {
  test("GET requires settings.read; PUT requires settings.write", () => {
    expect(
      findRoute("llm_default_provider_get").policy?.requiredScopes,
    ).toEqual(["settings.read"]);
    expect(
      findRoute("llm_default_provider_put").policy?.requiredScopes,
    ).toEqual(["settings.write"]);
  });
});
