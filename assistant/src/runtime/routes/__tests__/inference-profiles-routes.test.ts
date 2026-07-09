/**
 * Tests for the inference-profile route handlers' write-time validation.
 *
 * Covers the guardrails that distinguish these routes from the generic
 * `config set llm.profiles.*` path:
 *   - bad provider (not in the LLMProvider enum)
 *   - uncataloged model without --allow-unlisted
 *   - missing provider connection
 *   - managed-profile create / update / delete rejection
 *
 * The happy-path write is intentionally not exercised here — it flows through
 * `commitConfigWrite` (disk write + provider reinit), which is covered by the
 * config-write tests.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Module mocks (must come before imports) ──────────────────────────────────

let fakeConfig: Record<string, unknown> = { llm: {} };
mock.module("../../../config/loader.js", () => ({
  getConfig: () => structuredClone(fakeConfig),
  getConfigReadOnly: () => structuredClone(fakeConfig),
  loadRawConfig: () => structuredClone(fakeConfig),
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
}));

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

// ── Real imports (after mocks) ────────────────────────────────────────────────

import { getDb } from "../../../persistence/db-connection.js";
import { initializeDb } from "../../../persistence/db-init.js";
import { providerConnections } from "../../../persistence/schema/inference.js";
import { BadRequestError, ConflictError, NotFoundError } from "../errors.js";
import { ROUTES } from "../inference-profiles-routes.js";
import type { RouteDefinition, RouteHandlerArgs } from "../types.js";

await initializeDb();

function handler(operationId: string): RouteDefinition["handler"] {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`Route ${operationId} not found`);
  }
  return route.handler;
}

function call(operationId: string, args: RouteHandlerArgs): Promise<unknown> {
  return Promise.resolve(handler(operationId)(args));
}

function seedConnection(name: string, provider: string): void {
  const now = Date.now();
  getDb()
    .insert(providerConnections)
    .values({
      name,
      provider,
      auth: JSON.stringify({ type: "none" }),
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

beforeEach(() => {
  getDb().delete(providerConnections).run();
  fakeConfig = { llm: {} };
});

// ── create validation ─────────────────────────────────────────────────────────

describe("POST inference/profiles (create) validation", () => {
  test("rejects an unknown provider", async () => {
    await expect(
      call("inference_profiles_create", {
        body: {
          name: "my-profile",
          provider: "bogus",
          model: "claude-opus-4-8",
        },
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  test("rejects an uncataloged model without allowUnlisted", async () => {
    await expect(
      call("inference_profiles_create", {
        body: {
          name: "my-profile",
          provider: "anthropic",
          model: "totally-made-up-model",
        },
      }),
    ).rejects.toThrow(/not in the catalog/);
  });

  test("rejects a missing provider connection", async () => {
    await expect(
      call("inference_profiles_create", {
        body: {
          name: "my-profile",
          provider: "anthropic",
          model: "claude-opus-4-8",
          connection: "does-not-exist",
        },
      }),
    ).rejects.toThrow(/does not exist/);
  });

  test("rejects creating a managed default name", async () => {
    await expect(
      call("inference_profiles_create", {
        body: {
          name: "balanced",
          provider: "anthropic",
          model: "claude-opus-4-8",
        },
      }),
    ).rejects.toThrow(/reserved for a code-defined default/);
  });
});

// ── update validation ─────────────────────────────────────────────────────────

describe("PATCH inference/profiles/:name (update) validation", () => {
  test("rejects editing a managed default profile", async () => {
    fakeConfig = {
      llm: {
        profiles: {
          balanced: {
            source: "managed",
            provider: "fireworks",
            model: "accounts/fireworks/models/glm-5p2",
          },
        },
      },
    };
    await expect(
      call("inference_profiles_update", {
        pathParams: { name: "balanced" },
        body: { effort: "low" },
      }),
    ).rejects.toThrow(/managed profile/);
  });

  test("404s an unknown profile", async () => {
    await expect(
      call("inference_profiles_update", {
        pathParams: { name: "ghost" },
        body: { effort: "low" },
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ── delete protection ───────────────────────────────────────────────────────

describe("DELETE inference/profiles/:name protection", () => {
  test("rejects deleting a managed default profile", async () => {
    fakeConfig = {
      llm: { profiles: { balanced: { source: "managed" } } },
    };
    await expect(
      call("inference_profiles_delete", { pathParams: { name: "balanced" } }),
    ).rejects.toThrow(/managed profile/);
  });

  test("404s an unknown profile", async () => {
    fakeConfig = { llm: { profiles: {} } };
    await expect(
      call("inference_profiles_delete", { pathParams: { name: "ghost" } }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ── duplicate create ──────────────────────────────────────────────────────────

describe("POST inference/profiles create conflict", () => {
  test("409s when a profile with the name already exists", async () => {
    seedConnection("anthropic-personal", "anthropic");
    fakeConfig = {
      llm: {
        profiles: { existing: { source: "user", provider: "anthropic" } },
      },
    };
    await expect(
      call("inference_profiles_create", {
        body: {
          name: "existing",
          provider: "anthropic",
          model: "claude-opus-4-8",
          connection: "anthropic-personal",
        },
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});
