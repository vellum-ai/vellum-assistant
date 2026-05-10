/**
 * Tests for the inference provider connection route handlers.
 *
 * Covers:
 *   GET    /v1/inference/provider-connections          — list (empty, multiple, ?provider= filter)
 *   GET    /v1/inference/provider-connections/:name    — single, 404
 *   POST   /v1/inference/provider-connections          — create happy paths + 409 + 400 cases
 *   PATCH  /v1/inference/provider-connections/:name    — update auth, 404
 *   DELETE /v1/inference/provider-connections/:name    — happy path, 409 with profile ref, 409 with call-site ref
 *   Auth   — 401 (missing key) and 403 (insufficient scope) via route-policy assertions
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Module mocks (must come before imports) ──────────────────────────────────

// Config is read by the DELETE handler to find referencing profiles/call-sites.
let fakeConfig: Record<string, unknown> = {};
mock.module("../../../config/loader.js", () => ({
  getConfigReadOnly: () => fakeConfig,
  getConfig: () => fakeConfig,
  invalidateConfigCache: () => {},
}));

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

// ── Real imports (after mocks) ────────────────────────────────────────────────

import { getDb } from "../../../memory/db-connection.js";
import { initializeDb } from "../../../memory/db-init.js";
import { providerConnections } from "../../../memory/schema/inference.js";
import { getPolicy } from "../../auth/route-policy.js";
import { BadRequestError, ConflictError, NotFoundError } from "../errors.js";
import { ROUTES } from "../inference-provider-connection-routes.js";
import type { RouteDefinition, RouteHandlerArgs } from "../types.js";

// ── DB bootstrap ──────────────────────────────────────────────────────────────

initializeDb();

// ── Helpers ───────────────────────────────────────────────────────────────────

function findHandler(operationId: string): RouteDefinition["handler"] {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`Route ${operationId} not found`);
  return route.handler;
}

function findRoute(operationId: string): RouteDefinition {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`Route ${operationId} not found`);
  return route;
}

async function call(
  handler: RouteDefinition["handler"],
  args: RouteHandlerArgs,
): Promise<unknown> {
  return await handler(args);
}

function clearConnections(): void {
  getDb().delete(providerConnections).run();
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
  clearConnections();
  fakeConfig = {};
});

// ── GET list ─────────────────────────────────────────────────────────────────

describe("GET inference/provider-connections (list)", () => {
  test("returns empty list when no connections exist", async () => {
    const result = (await call(
      findHandler("inference_provider_connections_list"),
      {},
    )) as { connections: unknown[] };
    expect(result.connections).toEqual([]);
  });

  test("returns all connections when no filter", async () => {
    seedConnection({ name: "conn-a", provider: "anthropic", auth: { type: "platform" } });
    seedConnection({ name: "conn-b", provider: "openai", auth: { type: "none" } });

    const result = (await call(
      findHandler("inference_provider_connections_list"),
      {},
    )) as { connections: Array<{ name: string }> };
    const names = result.connections.map((c) => c.name).sort();
    expect(names).toEqual(["conn-a", "conn-b"]);
  });

  test("filters by ?provider= query param", async () => {
    seedConnection({ name: "ant-1", provider: "anthropic", auth: { type: "platform" } });
    seedConnection({ name: "oai-1", provider: "openai", auth: { type: "platform" } });

    const result = (await call(
      findHandler("inference_provider_connections_list"),
      { queryParams: { provider: "openai" } },
    )) as { connections: Array<{ name: string; provider: string }> };
    expect(result.connections).toHaveLength(1);
    expect(result.connections[0].name).toBe("oai-1");
    expect(result.connections[0].provider).toBe("openai");
  });

  test("returns empty list when provider filter matches nothing", async () => {
    seedConnection({ name: "ant-1", provider: "anthropic", auth: { type: "platform" } });

    const result = (await call(
      findHandler("inference_provider_connections_list"),
      { queryParams: { provider: "gemini" } },
    )) as { connections: unknown[] };
    expect(result.connections).toEqual([]);
  });
});

// ── GET single ────────────────────────────────────────────────────────────────

describe("GET inference/provider-connections/:name (single)", () => {
  test("returns connection when it exists", async () => {
    seedConnection({ name: "my-conn", provider: "anthropic", auth: { type: "platform" } });

    const result = (await call(
      findHandler("inference_provider_connections_get"),
      { pathParams: { name: "my-conn" } },
    )) as { name: string; provider: string; auth: object };
    expect(result.name).toBe("my-conn");
    expect(result.provider).toBe("anthropic");
    expect(result.auth).toEqual({ type: "platform" });
  });

  test("throws 404 when connection not found", async () => {
    await expect(
      call(findHandler("inference_provider_connections_get"), {
        pathParams: { name: "nonexistent" },
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ── POST create ───────────────────────────────────────────────────────────────

describe("POST inference/provider-connections (create)", () => {
  test("creates connection with api_key auth", async () => {
    const result = (await call(
      findHandler("inference_provider_connections_create"),
      {
        body: {
          name: "my-anthropic",
          provider: "anthropic",
          auth: { type: "api_key", credential: "vault/anthropic/key" },
        },
      },
    )) as { name: string; provider: string; auth: object; createdAt: number };

    expect(result.name).toBe("my-anthropic");
    expect(result.provider).toBe("anthropic");
    expect(result.auth).toEqual({ type: "api_key", credential: "vault/anthropic/key" });
    expect(typeof result.createdAt).toBe("number");
  });

  test("creates connection with platform auth", async () => {
    const result = (await call(
      findHandler("inference_provider_connections_create"),
      {
        body: { name: "managed-openai", provider: "openai", auth: { type: "platform" } },
      },
    )) as { auth: object };
    expect(result.auth).toEqual({ type: "platform" });
  });

  test("creates connection with none auth (e.g. ollama)", async () => {
    const result = (await call(
      findHandler("inference_provider_connections_create"),
      {
        body: { name: "ollama-local", provider: "ollama", auth: { type: "none" } },
      },
    )) as { auth: object };
    expect(result.auth).toEqual({ type: "none" });
  });

  test("throws 409 when connection name already exists", async () => {
    seedConnection({ name: "dup-name", provider: "anthropic", auth: { type: "platform" } });

    await expect(
      call(findHandler("inference_provider_connections_create"), {
        body: { name: "dup-name", provider: "openai", auth: { type: "platform" } },
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  test("throws 400 when provider is invalid", async () => {
    await expect(
      call(findHandler("inference_provider_connections_create"), {
        body: { name: "test", provider: "bogus-provider", auth: { type: "platform" } },
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  test("throws 400 when auth schema is invalid (api_key without credential)", async () => {
    await expect(
      call(findHandler("inference_provider_connections_create"), {
        body: { name: "test", provider: "anthropic", auth: { type: "api_key" } },
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  test("throws 400 when auth type is unknown", async () => {
    await expect(
      call(findHandler("inference_provider_connections_create"), {
        body: { name: "test", provider: "anthropic", auth: { type: "magic_beans" } },
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  test("throws 400 when name is missing", async () => {
    await expect(
      call(findHandler("inference_provider_connections_create"), {
        body: { provider: "anthropic", auth: { type: "platform" } },
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });
});

// ── PATCH update ──────────────────────────────────────────────────────────────

describe("PATCH inference/provider-connections/:name (update)", () => {
  test("updates auth on existing connection", async () => {
    seedConnection({ name: "upd-conn", provider: "anthropic", auth: { type: "platform" } });

    const result = (await call(
      findHandler("inference_provider_connections_update"),
      {
        pathParams: { name: "upd-conn" },
        body: { auth: { type: "api_key", credential: "vault/key" } },
      },
    )) as { auth: object; provider: string };
    expect(result.auth).toEqual({ type: "api_key", credential: "vault/key" });
    expect(result.provider).toBe("anthropic");
  });

  test("throws 404 when connection does not exist", async () => {
    await expect(
      call(findHandler("inference_provider_connections_update"), {
        pathParams: { name: "missing" },
        body: { auth: { type: "platform" } },
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("throws 400 when auth schema is invalid", async () => {
    seedConnection({ name: "bad-auth", provider: "openai", auth: { type: "platform" } });

    await expect(
      call(findHandler("inference_provider_connections_update"), {
        pathParams: { name: "bad-auth" },
        body: { auth: { type: "api_key" } }, // missing credential
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });
});

// ── DELETE ────────────────────────────────────────────────────────────────────

describe("DELETE inference/provider-connections/:name (delete)", () => {
  test("deletes an unreferenced connection", async () => {
    seedConnection({ name: "del-me", provider: "gemini", auth: { type: "platform" } });

    const result = (await call(
      findHandler("inference_provider_connections_delete"),
      { pathParams: { name: "del-me" } },
    )) as { ok: boolean };
    expect(result.ok).toBe(true);

    // Verify it's gone
    await expect(
      call(findHandler("inference_provider_connections_get"), {
        pathParams: { name: "del-me" },
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("throws 404 when connection does not exist", async () => {
    await expect(
      call(findHandler("inference_provider_connections_delete"), {
        pathParams: { name: "no-such-conn" },
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("throws 409 when a profile references the connection", async () => {
    seedConnection({ name: "ref-conn", provider: "anthropic", auth: { type: "platform" } });
    fakeConfig = {
      llm: {
        profiles: {
          "my-profile": { provider_connection: "ref-conn", model: "claude-opus-4-7" },
        },
      },
    };

    const err = await call(
      findHandler("inference_provider_connections_delete"),
      { pathParams: { name: "ref-conn" } },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).message).toContain("ref-conn");
    expect((err as ConflictError).message).toContain("my-profile");
  });

  test("throws 409 when llm.default references the connection", async () => {
    seedConnection({ name: "default-conn", provider: "anthropic", auth: { type: "platform" } });
    fakeConfig = {
      llm: {
        default: { provider_connection: "default-conn" },
      },
    };

    const err = await call(
      findHandler("inference_provider_connections_delete"),
      { pathParams: { name: "default-conn" } },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).message).toContain("default-conn");
    expect((err as ConflictError).message).toContain("llm.default");
  });

  test("throws 404 (not 409) when llm.default references a missing connection", async () => {
    // Stale ref in config: llm.default points at a connection that was
    // already deleted. Delete on the dangling name must return 404 so
    // callers can distinguish stale config from active conflicts.
    fakeConfig = {
      llm: {
        default: { provider_connection: "ghost-conn" },
      },
    };

    await expect(
      call(findHandler("inference_provider_connections_delete"), {
        pathParams: { name: "ghost-conn" },
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("throws 409 when both llm.default and a profile reference the connection", async () => {
    seedConnection({ name: "shared-conn", provider: "anthropic", auth: { type: "none" } });
    fakeConfig = {
      llm: {
        default: { provider_connection: "shared-conn" },
        profiles: { "prof-a": { provider_connection: "shared-conn" } },
      },
    };

    // llm.default check fires first (before profiles check).
    const err = await call(
      findHandler("inference_provider_connections_delete"),
      { pathParams: { name: "shared-conn" } },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).message).toContain("llm.default");
  });
});

// ── Auth / route-policy wiring ────────────────────────────────────────────────

describe("Route policy registrations", () => {
  test("GET list has settings.read policy", () => {
    const route = findRoute("inference_provider_connections_list");
    const policyKey = `${route.policyKey ?? "inference/provider-connections"}:GET`;
    const policy = getPolicy(policyKey);
    expect(policy).toBeDefined();
    expect(policy?.requiredScopes).toContain("settings.read");
  });

  test("POST create has settings.write policy", () => {
    const route = findRoute("inference_provider_connections_create");
    const policyKey = `${route.policyKey ?? "inference/provider-connections"}:POST`;
    const policy = getPolicy(policyKey);
    expect(policy).toBeDefined();
    expect(policy?.requiredScopes).toContain("settings.write");
  });

  test("GET single has settings.read policy", () => {
    const route = findRoute("inference_provider_connections_get");
    const policyKey = `${route.policyKey ?? "inference/provider-connections/detail"}:GET`;
    const policy = getPolicy(policyKey);
    expect(policy).toBeDefined();
    expect(policy?.requiredScopes).toContain("settings.read");
  });

  test("PATCH update has settings.write policy", () => {
    const route = findRoute("inference_provider_connections_update");
    const policyKey = `${route.policyKey ?? "inference/provider-connections/detail"}:PATCH`;
    const policy = getPolicy(policyKey);
    expect(policy).toBeDefined();
    expect(policy?.requiredScopes).toContain("settings.write");
  });

  test("DELETE has settings.write policy", () => {
    const route = findRoute("inference_provider_connections_delete");
    const policyKey = `${route.policyKey ?? "inference/provider-connections/detail"}:DELETE`;
    const policy = getPolicy(policyKey);
    expect(policy).toBeDefined();
    expect(policy?.requiredScopes).toContain("settings.write");
  });
});
