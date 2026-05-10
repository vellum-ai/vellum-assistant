/**
 * Cutover-proof parity test: CLI create vs HTTP route create.
 *
 * Runs a CLI `createConnection` call and an HTTP-route `handleCreateConnection`
 * call with the same payload, then asserts the resulting DB rows are identical
 * (after normalizing timestamps). This proves the HTTP route wraps the same
 * store path the CLI uses — no divergent code path.
 *
 * Rule: cc-cutover-proof (see PR_B_TASK.md).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Module mocks (must come before imports) ──────────────────────────────────

mock.module("../../../config/loader.js", () => ({
  getConfigReadOnly: () => ({}),
  getConfig: () => ({}),
  invalidateConfigCache: () => {},
}));

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

// ── Real imports ──────────────────────────────────────────────────────────────

import { getDb } from "../../../memory/db-connection.js";
import { initializeDb } from "../../../memory/db-init.js";
import { providerConnections } from "../../../memory/schema/inference.js";
import { createConnection, getConnection } from "../../../providers/inference/connections.js";
import { ROUTES } from "../inference-provider-connection-routes.js";
import type { RouteDefinition } from "../types.js";

// ── DB bootstrap ──────────────────────────────────────────────────────────────

initializeDb();

// ── Helpers ───────────────────────────────────────────────────────────────────

function findHandler(operationId: string): RouteDefinition["handler"] {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`Route ${operationId} not found`);
  return route.handler;
}

function clearConnections(): void {
  getDb().delete(providerConnections).run();
}

function normalizeTimestamps<T extends object>(obj: T): Omit<T, "createdAt" | "updatedAt"> {
  const { createdAt: _c, updatedAt: _u, ...rest } = obj as T & { createdAt?: unknown; updatedAt?: unknown };
  return rest as Omit<T, "createdAt" | "updatedAt">;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  clearConnections();
});

describe("CLI vs HTTP route parity", () => {
  test("api_key connection: CLI createConnection and HTTP POST produce identical DB rows", async () => {
    const payload = {
      name: "parity-anthropic",
      provider: "anthropic" as const,
      auth: { type: "api_key" as const, credential: "vault/anthropic/key" },
    };

    // ── CLI path ──────────────────────────────────────────────────────────────
    const cliResult = createConnection(getDb(), payload);
    expect(cliResult.ok).toBe(true);
    if (!cliResult.ok) throw new Error("CLI create failed");
    const cliRow = getConnection(getDb(), payload.name);
    expect(cliRow).not.toBeNull();

    // Clean up CLI row before HTTP create so names don't collide.
    clearConnections();

    // ── HTTP route path ───────────────────────────────────────────────────────
    const httpResult = (await findHandler("inference_provider_connections_create")({
      body: {
        name: payload.name,
        provider: payload.provider,
        auth: payload.auth,
      },
    })) as { name: string; provider: string; auth: object };

    expect(httpResult.name).toBe(payload.name);
    const httpRow = getConnection(getDb(), payload.name);
    expect(httpRow).not.toBeNull();

    // ── Compare ───────────────────────────────────────────────────────────────
    // Both rows should have identical non-timestamp fields.
    expect(normalizeTimestamps(httpRow!)).toEqual(normalizeTimestamps(cliRow!));
  });

  test("platform connection: CLI createConnection and HTTP POST produce identical DB rows", async () => {
    const payload = {
      name: "parity-openai-managed",
      provider: "openai" as const,
      auth: { type: "platform" as const },
    };

    const cliResult = createConnection(getDb(), payload);
    expect(cliResult.ok).toBe(true);
    if (!cliResult.ok) throw new Error("CLI create failed");
    const cliRow = getConnection(getDb(), payload.name);

    clearConnections();

    await findHandler("inference_provider_connections_create")({
      body: { name: payload.name, provider: payload.provider, auth: payload.auth },
    });
    const httpRow = getConnection(getDb(), payload.name);

    expect(normalizeTimestamps(httpRow!)).toEqual(normalizeTimestamps(cliRow!));
  });

  test("none auth connection: CLI createConnection and HTTP POST produce identical DB rows", async () => {
    const payload = {
      name: "parity-ollama",
      provider: "ollama" as const,
      auth: { type: "none" as const },
    };

    const cliResult = createConnection(getDb(), payload);
    expect(cliResult.ok).toBe(true);
    if (!cliResult.ok) throw new Error("CLI create failed");
    const cliRow = getConnection(getDb(), payload.name);

    clearConnections();

    await findHandler("inference_provider_connections_create")({
      body: { name: payload.name, provider: payload.provider, auth: payload.auth },
    });
    const httpRow = getConnection(getDb(), payload.name);

    expect(normalizeTimestamps(httpRow!)).toEqual(normalizeTimestamps(cliRow!));
  });
});
