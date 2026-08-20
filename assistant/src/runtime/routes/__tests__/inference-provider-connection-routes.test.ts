/**
 * Tests for the inference provider connection route handlers.
 *
 * Covers:
 *   GET    /v1/inference/provider-connections          — list (empty, multiple, ?provider= filter)
 *   GET    /v1/inference/provider-connections/:name    — single, 404
 *   POST   /v1/inference/provider-connections          — create happy paths + 409 + 400 cases
 *   PATCH  /v1/inference/provider-connections/:name    — update auth, 404
 *   DELETE /v1/inference/provider-connections/:name    — happy path, 409 with profile ref, llm.defaultProvider guard
 *   Auth   — 401 (missing key) and 403 (insufficient scope) via route-policy assertions
 */

import { beforeEach, describe, expect, test } from "bun:test";

// ── Real imports ──────────────────────────────────────────────────────────────
import { setConfig } from "../../../__tests__/helpers/set-config.js";
import { LLMSchema } from "../../../config/schemas/llm.js";
import { getDb } from "../../../persistence/db-connection.js";
import { initializeDb } from "../../../persistence/db-init.js";
import { providerConnections } from "../../../persistence/schema/inference.js";
// Route policies are read directly off `route.policy` now (ATL-315
// followup) — no registry lookup.
import { BadRequestError, ConflictError, NotFoundError } from "../errors.js";
import { ROUTES } from "../inference-provider-connection-routes.js";
import type { RouteDefinition, RouteHandlerArgs } from "../types.js";

// ── DB bootstrap ──────────────────────────────────────────────────────────────

await initializeDb();

// ── Helpers ───────────────────────────────────────────────────────────────────

function findHandler(operationId: string): RouteDefinition["handler"] {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`Route ${operationId} not found`);
  }
  return route.handler;
}

function findRoute(operationId: string): RouteDefinition {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`Route ${operationId} not found`);
  }
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
  setConfig("llm", {});
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
    seedConnection({
      name: "conn-a",
      provider: "anthropic",
      auth: { type: "platform" },
    });
    seedConnection({
      name: "conn-b",
      provider: "openai",
      auth: { type: "none" },
    });

    const result = (await call(
      findHandler("inference_provider_connections_list"),
      {},
    )) as { connections: Array<{ name: string }> };
    const names = result.connections.map((c) => c.name).sort();
    expect(names).toEqual(["conn-a", "conn-b"]);
  });

  test("filters by ?provider= query param", async () => {
    seedConnection({
      name: "ant-1",
      provider: "anthropic",
      auth: { type: "platform" },
    });
    seedConnection({
      name: "oai-1",
      provider: "openai",
      auth: { type: "platform" },
    });

    const result = (await call(
      findHandler("inference_provider_connections_list"),
      { queryParams: { provider: "openai" } },
    )) as { connections: Array<{ name: string; provider: string }> };
    expect(result.connections).toHaveLength(1);
    expect(result.connections[0].name).toBe("oai-1");
    expect(result.connections[0].provider).toBe("openai");
  });

  test("returns empty list when provider filter matches nothing", async () => {
    seedConnection({
      name: "ant-1",
      provider: "anthropic",
      auth: { type: "platform" },
    });

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
    seedConnection({
      name: "my-conn",
      provider: "anthropic",
      auth: { type: "platform" },
    });

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
    expect(result.auth).toEqual({
      type: "api_key",
      credential: "vault/anthropic/key",
    });
    expect(typeof result.createdAt).toBe("number");
  });

  test("creates connection with platform auth", async () => {
    const result = (await call(
      findHandler("inference_provider_connections_create"),
      {
        body: {
          name: "managed-openai",
          provider: "vellum",
          auth: { type: "platform" },
        },
      },
    )) as { auth: object };
    expect(result.auth).toEqual({ type: "platform" });
  });

  test("rejects platform auth on a real provider", async () => {
    const err = await call(
      findHandler("inference_provider_connections_create"),
      {
        body: {
          name: "managed-openai",
          provider: "openai",
          auth: { type: "platform" },
        },
      },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestError);
    expect((err as BadRequestError).message).toContain("platform");
    expect((err as BadRequestError).message).toContain("vellum");
  });

  test("rejects a chatgpt identity row under a non-canonical name", async () => {
    const err = await call(
      findHandler("inference_provider_connections_create"),
      {
        body: {
          name: "my-chatgpt",
          provider: "chatgpt",
          auth: { type: "oauth_subscription", credential: "credential/x" },
        },
      },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestError);
    expect((err as BadRequestError).message).toContain("chatgpt-subscription");
  });

  test("rejects key auth on the chatgpt provider, derived or explicit", async () => {
    for (const body of [
      {
        name: "chatgpt-subscription",
        provider: "chatgpt",
        auth: { type: "api_key", credential: "vault/x" },
      },
      // No explicit auth: derivation would fall through to api_key.
      {
        name: "chatgpt-subscription",
        provider: "chatgpt",
        credential: "vault/x",
      },
    ]) {
      const err = await call(
        findHandler("inference_provider_connections_create"),
        { body },
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestError);
      expect((err as BadRequestError).message).toContain("sign-in");
    }
  });

  test("rejects subscription auth on a non-chatgpt provider", async () => {
    const err = await call(
      findHandler("inference_provider_connections_create"),
      {
        body: {
          name: "keyed-oauth",
          provider: "openai",
          auth: { type: "oauth_subscription", credential: "credential/x" },
        },
      },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestError);
    expect((err as BadRequestError).message).toContain("chatgpt");
  });

  test("rejects key auth on the vellum provider", async () => {
    const err = await call(
      findHandler("inference_provider_connections_create"),
      {
        body: {
          name: "keyed-vellum",
          provider: "vellum",
          auth: { type: "api_key", credential: "vault/vellum/key" },
        },
      },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestError);
    expect((err as BadRequestError).message).toContain("vellum");
  });

  test("creates connection with none auth (e.g. ollama)", async () => {
    const result = (await call(
      findHandler("inference_provider_connections_create"),
      {
        body: {
          name: "ollama-local",
          provider: "ollama",
          auth: { type: "none" },
        },
      },
    )) as { auth: object; baseUrl: string | null };
    expect(result.auth).toEqual({ type: "none" });
    expect(result.baseUrl).toBeNull();
  });

  test("creates an ollama connection with an optional base_url", async () => {
    const result = (await call(
      findHandler("inference_provider_connections_create"),
      {
        body: {
          name: "ollama-remote",
          provider: "ollama",
          auth: { type: "none" },
          base_url: "http://192.168.1.50:11434/v1",
        },
      },
    )) as { auth: object; baseUrl: string | null };
    expect(result.auth).toEqual({ type: "none" });
    expect(result.baseUrl).toBe("http://192.168.1.50:11434/v1");
  });

  test("updates an ollama connection base_url and can clear it", async () => {
    await call(findHandler("inference_provider_connections_create"), {
      body: {
        name: "ollama-editable",
        provider: "ollama",
        auth: { type: "none" },
      },
    });

    const updated = (await call(
      findHandler("inference_provider_connections_update"),
      {
        pathParams: { name: "ollama-editable" },
        body: {
          auth: { type: "none" },
          base_url: "http://127.0.0.1:11434/v1",
        },
      },
    )) as { baseUrl: string | null };
    expect(updated.baseUrl).toBe("http://127.0.0.1:11434/v1");

    const cleared = (await call(
      findHandler("inference_provider_connections_update"),
      {
        pathParams: { name: "ollama-editable" },
        body: {
          auth: { type: "none" },
          base_url: null,
        },
      },
    )) as { baseUrl: string | null };
    expect(cleared.baseUrl).toBeNull();
  });

  test("derives api_key auth from provider + credential when auth is omitted", async () => {
    const result = (await call(
      findHandler("inference_provider_connections_create"),
      {
        body: {
          name: "derived-anthropic",
          provider: "anthropic",
          credential: "vault/anthropic/key",
        },
      },
    )) as { auth: object };
    expect(result.auth).toEqual({
      type: "api_key",
      credential: "vault/anthropic/key",
    });
  });

  test("derives none auth for keyless providers when auth is omitted", async () => {
    const result = (await call(
      findHandler("inference_provider_connections_create"),
      {
        body: { name: "derived-ollama", provider: "ollama" },
      },
    )) as { auth: object };
    expect(result.auth).toEqual({ type: "none" });
  });

  test("derives platform auth for the vellum provider when auth is omitted", async () => {
    const result = (await call(
      findHandler("inference_provider_connections_create"),
      {
        body: { name: "derived-vellum", provider: "vellum" },
      },
    )) as { auth: object };
    expect(result.auth).toEqual({ type: "platform" });
  });

  test("rejects a whitespace-only label", async () => {
    await expect(
      call(findHandler("inference_provider_connections_create"), {
        body: {
          name: "blank-label",
          provider: "openai-compatible",
          label: "   ",
          base_url: "http://localhost:1234/v1",
          models: [{ id: "my-model" }],
        },
      }),
    ).rejects.toThrow(/non-blank string or null/);
  });

  test("rejects a custom-provider label matching a built-in provider", async () => {
    await expect(
      call(findHandler("inference_provider_connections_create"), {
        body: {
          name: "sneaky",
          provider: "openai-compatible",
          label: "Anthropic",
          base_url: "http://localhost:1234/v1",
          models: [{ id: "my-model" }],
        },
      }),
    ).rejects.toThrow(/belongs to a built-in provider/);
  });

  test("rejects a custom-provider label duplicating another custom provider", async () => {
    await call(findHandler("inference_provider_connections_create"), {
      body: {
        name: "first-endpoint",
        provider: "openai-compatible",
        label: "xAI",
        base_url: "http://localhost:1234/v1",
        models: [{ id: "my-model" }],
      },
    });
    await expect(
      call(findHandler("inference_provider_connections_create"), {
        body: {
          name: "second-endpoint",
          provider: "openai-compatible",
          label: "xai",
          base_url: "http://localhost:5678/v1",
          models: [{ id: "other" }],
        },
      }),
    ).rejects.toThrow(/already exists/);
    // Updating a different row onto the taken label is rejected too; keeping
    // its own label is fine.
    await call(findHandler("inference_provider_connections_create"), {
      body: {
        name: "third-endpoint",
        provider: "openai-compatible",
        label: "Local Box",
        base_url: "http://localhost:9999/v1",
        models: [{ id: "m" }],
      },
    });
    await expect(
      call(findHandler("inference_provider_connections_update"), {
        pathParams: { name: "third-endpoint" },
        body: { label: "xAI" },
      }),
    ).rejects.toThrow(/already exists/);
    await call(findHandler("inference_provider_connections_update"), {
      pathParams: { name: "first-endpoint" },
      body: { label: "xAI" },
    });
  });

  test("catalog providers may reuse their own display name as a label", async () => {
    const result = (await call(
      findHandler("inference_provider_connections_create"),
      {
        body: {
          name: "anthropic-personal",
          provider: "anthropic",
          label: "Anthropic",
          credential: "credential/anthropic/api_key",
        },
      },
    )) as { label: string | null };
    expect(result.label).toBe("Anthropic");
  });

  test("a label-less custom provider's name is validated as its identity", async () => {
    await expect(
      call(findHandler("inference_provider_connections_create"), {
        body: {
          name: "openai",
          provider: "openai-compatible",
          base_url: "http://localhost:1234/v1",
          models: [{ id: "my-model" }],
        },
      }),
    ).rejects.toThrow(/reserved as a provider id/);

    await call(findHandler("inference_provider_connections_create"), {
      body: {
        name: "endpoint-a",
        provider: "openai-compatible",
        label: "My Box",
        base_url: "http://localhost:1234/v1",
        models: [{ id: "my-model" }],
      },
    });
    await expect(
      call(findHandler("inference_provider_connections_create"), {
        body: {
          name: "my box",
          provider: "openai-compatible",
          base_url: "http://localhost:5678/v1",
          models: [{ id: "other" }],
        },
      }),
    ).rejects.toThrow(/already exists/);
  });

  test("an unchanged label is not re-validated, so pre-validation rows stay editable", async () => {
    const now = Date.now();
    getDb()
      .insert(providerConnections)
      .values({
        name: "legacy-endpoint",
        provider: "openai-compatible",
        label: " Anthropic ",
        auth: JSON.stringify({ type: "none" }),
        baseUrl: "http://localhost:1234/v1",
        models: JSON.stringify([{ id: "my-model" }]),
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const result = (await call(
      findHandler("inference_provider_connections_update"),
      {
        pathParams: { name: "legacy-endpoint" },
        body: { models: [{ id: "another-model" }] },
      },
    )) as { label: string | null };
    expect(result.label).toBe(" Anthropic ");

    // Labels compare trimmed: resending the stored label without its
    // padding is not an identity change.
    await call(findHandler("inference_provider_connections_update"), {
      pathParams: { name: "legacy-endpoint" },
      body: { label: "Anthropic", models: [{ id: "third-model" }] },
    });

    await expect(
      call(findHandler("inference_provider_connections_update"), {
        pathParams: { name: "legacy-endpoint" },
        body: { label: "OpenAI" },
      }),
    ).rejects.toThrow(/belongs to a built-in provider/);
  });

  test("attaches a failed endpoint_check when the custom base URL is unreachable", async () => {
    // Port 1 is never listening, so the probe fails fast with a network error.
    const result = (await call(
      findHandler("inference_provider_connections_create"),
      {
        body: {
          name: "probe-dead-endpoint",
          provider: "openai-compatible",
          auth: { type: "none" },
          base_url: "http://127.0.0.1:1",
          models: [{ id: "my-model" }],
        },
      },
    )) as { endpoint_check?: { ok: boolean; resolved_url: string } };
    expect(result.endpoint_check).toMatchObject({
      ok: false,
      resolved_url: "http://127.0.0.1:1/chat/completions",
    });
  });

  test("derives none auth for openai-compatible without a credential", async () => {
    const result = (await call(
      findHandler("inference_provider_connections_create"),
      {
        body: {
          name: "derived-local-llm",
          provider: "openai-compatible",
          base_url: "http://localhost:1234/v1",
          models: [{ id: "my-model" }],
        },
      },
    )) as { auth: object };
    expect(result.auth).toEqual({ type: "none" });
  });

  test("derives api_key auth for openai-compatible with a credential", async () => {
    const result = (await call(
      findHandler("inference_provider_connections_create"),
      {
        body: {
          name: "derived-hosted-llm",
          provider: "openai-compatible",
          credential: "credential/hosted/key",
          base_url: "https://api.example.com/v1",
          models: [{ id: "my-model" }],
        },
      },
    )) as { auth: object };
    expect(result.auth).toEqual({
      type: "api_key",
      credential: "credential/hosted/key",
    });
  });

  test("throws 400 on the reserved managed connection name", async () => {
    await expect(
      call(findHandler("inference_provider_connections_create"), {
        body: {
          name: "vellum",
          provider: "openai",
          credential: "credential/openai/api_key",
        },
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  test("throws 400 when auth is omitted and a keyed provider has no credential", async () => {
    await expect(
      call(findHandler("inference_provider_connections_create"), {
        body: { name: "derived-no-cred", provider: "anthropic" },
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  test("throws 400 when the derived credential is not a non-empty string", async () => {
    await expect(
      call(findHandler("inference_provider_connections_create"), {
        body: {
          name: "derived-bad-cred",
          provider: "anthropic",
          credential: "",
        },
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  test("throws 409 when connection name already exists", async () => {
    seedConnection({
      name: "dup-name",
      provider: "anthropic",
      auth: { type: "platform" },
    });

    await expect(
      call(findHandler("inference_provider_connections_create"), {
        body: {
          name: "dup-name",
          provider: "openai",
          auth: { type: "api_key", credential: "vault/openai/key" },
        },
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  test("throws 400 when provider is invalid", async () => {
    await expect(
      call(findHandler("inference_provider_connections_create"), {
        body: {
          name: "test",
          provider: "bogus-provider",
          auth: { type: "platform" },
        },
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  test("throws 400 when auth schema is invalid (api_key without credential)", async () => {
    await expect(
      call(findHandler("inference_provider_connections_create"), {
        body: {
          name: "test",
          provider: "anthropic",
          auth: { type: "api_key" },
        },
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  test("throws 400 when auth type is unknown", async () => {
    await expect(
      call(findHandler("inference_provider_connections_create"), {
        body: {
          name: "test",
          provider: "anthropic",
          auth: { type: "magic_beans" },
        },
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
    seedConnection({
      name: "upd-conn",
      provider: "anthropic",
      auth: { type: "platform" },
    });

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

  test("rejects switching a real provider's connection to platform auth", async () => {
    seedConnection({
      name: "byok-openai",
      provider: "openai",
      auth: { type: "api_key", credential: "vault/openai/key" },
    });

    const err = await call(
      findHandler("inference_provider_connections_update"),
      {
        pathParams: { name: "byok-openai" },
        body: { auth: { type: "platform" } },
      },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestError);
    expect((err as BadRequestError).message).toContain("platform");
  });

  // A persisted row whose provider and auth disagree stays editable: both the
  // web editor and the CLI resend the stored auth on every edit, so the guard
  // keys on an actual auth change rather than on the field being present.
  test("allows editing a legacy mismatched row when the client resends the stored auth", async () => {
    seedConnection({
      name: "legacy-managed-openai",
      provider: "openai",
      auth: { type: "platform" },
    });

    const result = (await call(
      findHandler("inference_provider_connections_update"),
      {
        pathParams: { name: "legacy-managed-openai" },
        body: { auth: { type: "platform" }, label: "Legacy" },
      },
    )) as { label: string | null; auth: object };
    expect(result.label).toBe("Legacy");
    expect(result.auth).toEqual({ type: "platform" });
  });

  test("allows editing a legacy mismatched row when auth is omitted", async () => {
    seedConnection({
      name: "legacy-managed-gemini",
      provider: "gemini",
      auth: { type: "platform" },
    });

    const result = (await call(
      findHandler("inference_provider_connections_update"),
      {
        pathParams: { name: "legacy-managed-gemini" },
        body: { label: "Legacy" },
      },
    )) as { label: string | null };
    expect(result.label).toBe("Legacy");
  });

  // The guard must not trap a legacy row in its mismatched state: an auth
  // change that repairs the pairing is exactly what should be allowed.
  // The canonical subscription row owns the "chatgpt" identity: writing
  // subscription auth to it stamps the provider (the CLI login-chatgpt path
  // PATCHes auth through this route on a row the identity migration
  // deliberately skipped).
  test("stamps the chatgpt identity when subscription auth lands on the canonical row", async () => {
    seedConnection({
      name: "chatgpt-subscription",
      provider: "openai",
      auth: { type: "api_key", credential: "vault/openai/key" },
    });

    const result = (await call(
      findHandler("inference_provider_connections_update"),
      {
        pathParams: { name: "chatgpt-subscription" },
        body: {
          auth: {
            type: "oauth_subscription",
            credential: "credential/chatgpt/access_token",
          },
        },
      },
    )) as { provider: string; auth: { type: string } };
    expect(result.provider).toBe("chatgpt");
    expect(result.auth.type).toBe("oauth_subscription");
  });

  test("does not stamp the identity for non-subscription auth on that name", async () => {
    seedConnection({
      name: "chatgpt-subscription",
      provider: "openai",
      auth: { type: "api_key", credential: "vault/openai/key" },
    });

    const result = (await call(
      findHandler("inference_provider_connections_update"),
      {
        pathParams: { name: "chatgpt-subscription" },
        body: {
          auth: { type: "api_key", credential: "vault/openai/other-key" },
        },
      },
    )) as { provider: string };
    expect(result.provider).toBe("openai");
  });

  test("allows repairing a legacy mismatched row with a valid auth change", async () => {
    seedConnection({
      name: "legacy-managed-anthropic",
      provider: "anthropic",
      auth: { type: "platform" },
    });

    const result = (await call(
      findHandler("inference_provider_connections_update"),
      {
        pathParams: { name: "legacy-managed-anthropic" },
        body: { auth: { type: "api_key", credential: "vault/anthropic/key" } },
      },
    )) as { auth: object };
    expect(result.auth).toEqual({
      type: "api_key",
      credential: "vault/anthropic/key",
    });
  });

  test("throws 400 when auth schema is invalid", async () => {
    seedConnection({
      name: "bad-auth",
      provider: "openai",
      auth: { type: "platform" },
    });

    await expect(
      call(findHandler("inference_provider_connections_update"), {
        pathParams: { name: "bad-auth" },
        body: { auth: { type: "api_key" } }, // missing credential
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  test("keeps stored auth when both auth and credential are omitted", async () => {
    seedConnection({
      name: "label-only",
      provider: "openai",
      auth: { type: "oauth_subscription", credential: "vault/chatgpt/token" },
    });

    const result = (await call(
      findHandler("inference_provider_connections_update"),
      {
        pathParams: { name: "label-only" },
        body: { label: "Renamed" },
      },
    )) as { auth: object; label: string | null };
    expect(result.auth).toEqual({
      type: "oauth_subscription",
      credential: "vault/chatgpt/token",
    });
    expect(result.label).toBe("Renamed");
  });

  test("throws 400 on credential-only PATCH of an oauth_subscription connection", async () => {
    seedConnection({
      name: "chatgpt-subscription",
      provider: "openai",
      auth: { type: "oauth_subscription", credential: "vault/chatgpt/token" },
    });

    await expect(
      call(findHandler("inference_provider_connections_update"), {
        pathParams: { name: "chatgpt-subscription" },
        body: { credential: "vault/other" },
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  test("rotates to derived api_key auth when only credential is passed", async () => {
    seedConnection({
      name: "rotate-cred",
      provider: "anthropic",
      auth: { type: "api_key", credential: "vault/old" },
    });

    const result = (await call(
      findHandler("inference_provider_connections_update"),
      {
        pathParams: { name: "rotate-cred" },
        body: { credential: "vault/new" },
      },
    )) as { auth: object };
    expect(result.auth).toEqual({ type: "api_key", credential: "vault/new" });
  });
});

// ── DELETE ────────────────────────────────────────────────────────────────────

describe("DELETE inference/provider-connections/:name (delete)", () => {
  test("deletes an unreferenced connection", async () => {
    seedConnection({
      name: "del-me",
      provider: "gemini",
      auth: { type: "platform" },
    });

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
    seedConnection({
      name: "ref-conn",
      provider: "anthropic",
      auth: { type: "platform" },
    });
    setConfig("llm", {
      profiles: {
        "my-profile": {
          provider_connection: "ref-conn",
          model: "claude-opus-4-7",
        },
      },
    });

    const err = await call(
      findHandler("inference_provider_connections_delete"),
      { pathParams: { name: "ref-conn" } },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).message).toContain("ref-conn");
    expect((err as ConflictError).message).toContain("my-profile");
  });

  test("throws 404 (not 409) when a profile references a missing connection", async () => {
    // Stale ref in config: a profile points at a connection that was
    // already deleted. Delete on the dangling name must return 404 so
    // callers can distinguish stale config from active conflicts.
    setConfig("llm", {
      profiles: { "ghost-prof": { provider_connection: "ghost-conn" } },
    });

    await expect(
      call(findHandler("inference_provider_connections_delete"), {
        pathParams: { name: "ghost-conn" },
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("throws 409 naming every referencing profile", async () => {
    seedConnection({
      name: "shared-conn",
      provider: "anthropic",
      auth: { type: "none" },
    });
    setConfig("llm", {
      profiles: {
        "prof-a": { provider_connection: "shared-conn" },
        "prof-b": { provider_connection: "shared-conn" },
      },
    });

    const err = await call(
      findHandler("inference_provider_connections_delete"),
      { pathParams: { name: "shared-conn" } },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).message).toContain("prof-a");
    expect((err as ConflictError).message).toContain("prof-b");
  });
});

// ── llm.defaultProvider guard ─────────────────────────────────────────────────

describe("DELETE guards the llm.defaultProvider reference", () => {
  test("throws 409 deleting the default's resolved connection (convention name)", async () => {
    seedConnection({
      name: "anthropic-personal",
      provider: "anthropic",
      auth: { type: "platform" },
    });
    setConfig("llm", { defaultProvider: { provider: "anthropic" } });

    const err = await call(
      findHandler("inference_provider_connections_delete"),
      { pathParams: { name: "anthropic-personal" } },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).message).toContain("llm.defaultProvider");
    expect((err as ConflictError).details).toEqual({
      referencedBy: ["llm.defaultProvider"],
    });
  });

  test("throws 409 deleting the default's explicit connectionName", async () => {
    seedConnection({
      name: "my-conn",
      provider: "openai",
      auth: { type: "platform" },
    });
    setConfig("llm", {
      defaultProvider: { provider: "openai", connectionName: "my-conn" },
    });

    await expect(
      call(findHandler("inference_provider_connections_delete"), {
        pathParams: { name: "my-conn" },
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  test("throws 409 deleting the last connection for the default provider when the convention name is dangling", async () => {
    // dp resolves to "anthropic-personal", which has no matching row — but
    // "anthropic-work" is the only connection for that provider, so deleting
    // it would strand the default with zero usable connections.
    seedConnection({
      name: "anthropic-work",
      provider: "anthropic",
      auth: { type: "platform" },
    });
    setConfig("llm", { defaultProvider: { provider: "anthropic" } });

    const err = await call(
      findHandler("inference_provider_connections_delete"),
      { pathParams: { name: "anthropic-work" } },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).details).toEqual({
      referencedBy: ["llm.defaultProvider"],
    });
  });

  test("succeeds deleting an unrelated last same-provider connection when the default pins an explicit connectionName", async () => {
    // The explicit pin is what the default references; "anthropic-work" is
    // unrelated even though it is the only anthropic row.
    seedConnection({
      name: "anthropic-work",
      provider: "anthropic",
      auth: { type: "platform" },
    });
    setConfig("llm", {
      defaultProvider: {
        provider: "anthropic",
        connectionName: "anthropic-personal",
      },
    });

    const result = await call(
      findHandler("inference_provider_connections_delete"),
      { pathParams: { name: "anthropic-work" } },
    );
    expect(result).toEqual({ ok: true });
  });

  test("throws 409 deleting the last visible connection when a hidden legacy row shares the provider", async () => {
    // "anthropic-managed" is filtered from the list route and must not count
    // as a remaining connection for the default provider.
    seedConnection({
      name: "anthropic-work",
      provider: "anthropic",
      auth: { type: "platform" },
    });
    seedConnection({
      name: "anthropic-managed",
      provider: "anthropic",
      auth: { type: "platform" },
    });
    setConfig("llm", { defaultProvider: { provider: "anthropic" } });

    const err = await call(
      findHandler("inference_provider_connections_delete"),
      { pathParams: { name: "anthropic-work" } },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).details).toEqual({
      referencedBy: ["llm.defaultProvider"],
    });
  });

  test("succeeds deleting a non-last connection for the default provider", async () => {
    seedConnection({
      name: "anthropic-personal",
      provider: "anthropic",
      auth: { type: "platform" },
    });
    seedConnection({
      name: "anthropic-other",
      provider: "anthropic",
      auth: { type: "platform" },
    });
    setConfig("llm", { defaultProvider: { provider: "anthropic" } });

    const result = (await call(
      findHandler("inference_provider_connections_delete"),
      { pathParams: { name: "anthropic-other" } },
    )) as { ok: boolean };
    expect(result.ok).toBe(true);
  });

  test("succeeds deleting a connection for a non-default provider", async () => {
    seedConnection({
      name: "openai-conn",
      provider: "openai",
      auth: { type: "platform" },
    });
    setConfig("llm", { defaultProvider: { provider: "anthropic" } });

    const result = (await call(
      findHandler("inference_provider_connections_delete"),
      { pathParams: { name: "openai-conn" } },
    )) as { ok: boolean };
    expect(result.ok).toBe(true);
  });

  test("succeeds deleting another provider's connection when the default provider has zero connections", async () => {
    seedConnection({
      name: "openai-conn",
      provider: "openai",
      auth: { type: "platform" },
    });
    // No "anthropic" rows exist at all — an already-dangling default is a
    // legal state; the guard must no-op rather than crash on an empty list.
    setConfig("llm", { defaultProvider: { provider: "anthropic" } });

    const result = (await call(
      findHandler("inference_provider_connections_delete"),
      { pathParams: { name: "openai-conn" } },
    )) as { ok: boolean };
    expect(result.ok).toBe(true);
  });

  test("succeeds when defaultProvider is absent", async () => {
    seedConnection({
      name: "some-conn",
      provider: "openai",
      auth: { type: "platform" },
    });
    setConfig("llm", {});

    const result = (await call(
      findHandler("inference_provider_connections_delete"),
      { pathParams: { name: "some-conn" } },
    )) as { ok: boolean };
    expect(result.ok).toBe(true);
  });

  test("succeeds when defaultProvider is malformed (dropped by the schema catch)", async () => {
    seedConnection({
      name: "some-conn",
      provider: "openai",
      auth: { type: "platform" },
    });
    const parsed = LLMSchema.parse({
      defaultProvider: { provider: "not-a-provider" },
    });
    expect(parsed.defaultProvider).toBeUndefined();
    setConfig("llm", parsed);

    const result = (await call(
      findHandler("inference_provider_connections_delete"),
      { pathParams: { name: "some-conn" } },
    )) as { ok: boolean };
    expect(result.ok).toBe(true);
  });

  test("managed-connection rejection still takes precedence over the defaultProvider guard", async () => {
    seedConnection({
      name: "vellum",
      provider: "vellum",
      auth: { type: "platform" },
    });
    setConfig("llm", { defaultProvider: { provider: "vellum" } });

    const err = await call(
      findHandler("inference_provider_connections_delete"),
      { pathParams: { name: "vellum" } },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestError);
  });
});

// ── label fields ─────────────────────────────────────────────────────────────

describe("POST with label", () => {
  test("creates connection with label, echoed in response", async () => {
    const result = (await call(
      findHandler("inference_provider_connections_create"),
      {
        body: {
          name: "labeled-conn",
          provider: "anthropic",
          auth: { type: "api_key", credential: "vault/anthropic/key" },
          label: "My Anthropic",
        },
      },
    )) as { name: string; label: string | null };
    expect(result.name).toBe("labeled-conn");
    expect(result.label).toBe("My Anthropic");
  });

  test("creates connection without label — label is null in response", async () => {
    const result = (await call(
      findHandler("inference_provider_connections_create"),
      {
        body: {
          name: "no-label-conn",
          provider: "openai",
          auth: { type: "api_key", credential: "vault/openai/key" },
        },
      },
    )) as { label: string | null };
    expect(result.label).toBeNull();
  });
});

describe("PATCH with label", () => {
  test("updates label to a string", async () => {
    seedConnection({
      name: "set-label",
      provider: "vellum",
      auth: { type: "platform" },
    });

    const result = (await call(
      findHandler("inference_provider_connections_update"),
      {
        pathParams: { name: "set-label" },
        body: { auth: { type: "platform" }, label: "My OpenAI" },
      },
    )) as { label: string | null };
    expect(result.label).toBe("My OpenAI");
  });

  test("clears label by setting it to null", async () => {
    seedConnection({
      name: "clear-label",
      provider: "vellum",
      auth: { type: "platform" },
    });
    // First set a label.
    await call(findHandler("inference_provider_connections_update"), {
      pathParams: { name: "clear-label" },
      body: { auth: { type: "platform" }, label: "Old Label" },
    });

    const result = (await call(
      findHandler("inference_provider_connections_update"),
      {
        pathParams: { name: "clear-label" },
        body: { auth: { type: "platform" }, label: null },
      },
    )) as { label: string | null };
    expect(result.label).toBeNull();
  });

  test("rejects label: empty string with 400", async () => {
    seedConnection({
      name: "reject-empty",
      provider: "vellum",
      auth: { type: "platform" },
    });

    await expect(
      call(findHandler("inference_provider_connections_update"), {
        pathParams: { name: "reject-empty" },
        body: { auth: { type: "platform" }, label: "" },
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });
});

// ── Managed-connection write protection ──────────────────────────────────────

describe("Managed connection write protection", () => {
  const MANAGED_NAMES = ["vellum"] as const;

  describe("DELETE", () => {
    for (const name of MANAGED_NAMES) {
      test(`rejects DELETE on ${name} with 400`, async () => {
        seedConnection({
          name,
          provider: name.replace("-managed", ""),
          auth: { type: "platform" },
        });

        const err = await call(
          findHandler("inference_provider_connections_delete"),
          { pathParams: { name } },
        ).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(BadRequestError);
        expect((err as BadRequestError).message).toContain(name);
        expect((err as BadRequestError).message).toContain("managed");
      });
    }

    test("managed protection short-circuits before reference checks", async () => {
      // Even though a profile references the managed connection, the error
      // should be the managed-protection 400, not the references-409.
      seedConnection({
        name: "vellum",
        provider: "vellum",
        auth: { type: "platform" },
      });
      setConfig("llm", {
        profiles: {
          balanced: { provider_connection: "vellum" },
        },
      });

      const err = await call(
        findHandler("inference_provider_connections_delete"),
        { pathParams: { name: "vellum" } },
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(BadRequestError);
      expect((err as BadRequestError).message).toContain("managed");
    });

    test("a user-owned row claiming the managed name stays deletable", async () => {
      // Boot seeding refuses to overwrite it and managed routing ignores it,
      // so deleting is the only way to restore the canonical row. The vellum
      // default resolves to this same name, and that guard must not block the
      // delete either: the next boot re-seeds the row it points at.
      seedConnection({
        name: "vellum",
        provider: "openai",
        auth: { type: "api_key", credential: "credential/openai/api_key" },
      });
      setConfig("llm", { defaultProvider: { provider: "vellum" } });

      await call(findHandler("inference_provider_connections_delete"), {
        pathParams: { name: "vellum" },
      });

      const remaining = (await call(
        findHandler("inference_provider_connections_list"),
        {},
      )) as { connections: unknown[] };
      expect(remaining.connections).toHaveLength(0);
    });
  });

  describe("PATCH auth", () => {
    for (const name of MANAGED_NAMES) {
      test(`rejects auth change on ${name} from platform to api_key with 400`, async () => {
        seedConnection({
          name,
          provider: name.replace("-managed", ""),
          auth: { type: "platform" },
        });

        const err = await call(
          findHandler("inference_provider_connections_update"),
          {
            pathParams: { name },
            body: { auth: { type: "api_key", credential: "ref/my-key" } },
          },
        ).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(BadRequestError);
        expect((err as BadRequestError).message).toContain(name);
        expect((err as BadRequestError).message).toContain("platform");
      });

      test(`rejects auth change on ${name} from platform to none with 400`, async () => {
        seedConnection({
          name,
          provider: name.replace("-managed", ""),
          auth: { type: "platform" },
        });

        const err = await call(
          findHandler("inference_provider_connections_update"),
          {
            pathParams: { name },
            body: { auth: { type: "none" } },
          },
        ).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(BadRequestError);
        expect((err as BadRequestError).message).toContain(name);
      });
    }

    test("allows PATCH with auth still set to platform (no-op auth change)", async () => {
      seedConnection({
        name: "vellum",
        provider: "vellum",
        auth: { type: "platform" },
      });

      const result = (await call(
        findHandler("inference_provider_connections_update"),
        {
          pathParams: { name: "vellum" },
          body: {
            auth: { type: "platform" },
            label: "Vellum-managed Anthropic",
          },
        },
      )) as { label: string | null };
      expect(result.label).toBe("Vellum-managed Anthropic");
    });
  });

  describe("PATCH label (allowed)", () => {
    test("allows relabeling a managed connection", async () => {
      seedConnection({
        name: "vellum",
        provider: "vellum",
        auth: { type: "platform" },
      });

      const result = (await call(
        findHandler("inference_provider_connections_update"),
        {
          pathParams: { name: "vellum" },
          body: { auth: { type: "platform" }, label: "Custom Label" },
        },
      )) as { label: string | null };
      expect(result.label).toBe("Custom Label");
    });
  });
});

// ── isManaged response flag ───────────────────────────────────────────────────

describe("isManaged flag on connection responses", () => {
  const MANAGED_NAMES = ["vellum"] as const;

  describe("GET list", () => {
    test("returns isManaged: true for canonical names and false for user-created rows", async () => {
      for (const name of MANAGED_NAMES) {
        seedConnection({
          name,
          provider: name.replace("-managed", ""),
          auth: { type: "platform" },
        });
      }
      seedConnection({
        name: "my-custom-anthropic",
        provider: "anthropic",
        auth: { type: "api_key", credential: "ref/k" },
      });

      const result = (await call(
        findHandler("inference_provider_connections_list"),
        {},
      )) as { connections: Array<{ name: string; isManaged: boolean }> };

      const byName = Object.fromEntries(
        result.connections.map((c) => [c.name, c.isManaged]),
      );
      expect(byName["vellum"]).toBe(true);
      expect(byName["my-custom-anthropic"]).toBe(false);
    });

    test("hides orphaned legacy *-managed rows from the list", async () => {
      // Existing installs (and fresh installs via migration 243) may still
      // carry the pre-consolidation rows until a follow-up migration deletes
      // them; they must not surface in the UI alongside `vellum`.
      for (const name of [
        "anthropic-managed",
        "openai-managed",
        "gemini-managed",
        "fireworks-managed",
        "together-managed",
      ]) {
        seedConnection({
          name,
          provider: name.replace("-managed", ""),
          auth: { type: "platform" },
        });
      }
      seedConnection({
        name: "vellum",
        provider: "vellum",
        auth: { type: "platform" },
      });
      seedConnection({
        name: "my-openai",
        provider: "openai",
        auth: { type: "api_key", credential: "ref/k" },
      });

      const result = (await call(
        findHandler("inference_provider_connections_list"),
        {},
      )) as { connections: Array<{ name: string }> };
      const names = result.connections.map((c) => c.name);

      expect(names).toContain("vellum");
      expect(names).toContain("my-openai");
      for (const legacy of [
        "anthropic-managed",
        "openai-managed",
        "gemini-managed",
        "fireworks-managed",
        "together-managed",
      ]) {
        expect(names).not.toContain(legacy);
      }
    });
  });

  describe("GET single", () => {
    test("returns isManaged: true for a managed name", async () => {
      seedConnection({
        name: "vellum",
        provider: "vellum",
        auth: { type: "platform" },
      });

      const result = (await call(
        findHandler("inference_provider_connections_get"),
        { pathParams: { name: "vellum" } },
      )) as { name: string; isManaged: boolean };

      expect(result.isManaged).toBe(true);
    });

    test("returns isManaged: false for a user-owned row claiming a managed name", async () => {
      // Clients gate edit and delete on this flag, so a claiming row must
      // report as the ordinary connection it is or the collision cannot be
      // cleared from the UI.
      seedConnection({
        name: "vellum",
        provider: "openai",
        auth: { type: "api_key", credential: "credential/openai/api_key" },
      });

      const result = (await call(
        findHandler("inference_provider_connections_get"),
        { pathParams: { name: "vellum" } },
      )) as { name: string; isManaged: boolean };

      expect(result.isManaged).toBe(false);
    });

    test("returns isManaged: false for a user-created name", async () => {
      seedConnection({
        name: "my-openai",
        provider: "openai",
        auth: { type: "api_key", credential: "ref/k" },
      });

      const result = (await call(
        findHandler("inference_provider_connections_get"),
        { pathParams: { name: "my-openai" } },
      )) as { name: string; isManaged: boolean };

      expect(result.isManaged).toBe(false);
    });
  });

  describe("POST create", () => {
    test("returns isManaged: false on a freshly-created user connection", async () => {
      const result = (await call(
        findHandler("inference_provider_connections_create"),
        {
          body: {
            name: "my-new-anthropic",
            provider: "anthropic",
            auth: { type: "api_key", credential: "ref/k" },
          },
        },
      )) as { name: string; isManaged: boolean };

      expect(result.isManaged).toBe(false);
    });
  });

  describe("PATCH update", () => {
    test("returns isManaged: true after relabeling a managed connection", async () => {
      seedConnection({
        name: "vellum",
        provider: "vellum",
        auth: { type: "platform" },
      });

      const result = (await call(
        findHandler("inference_provider_connections_update"),
        {
          pathParams: { name: "vellum" },
          body: { auth: { type: "platform" }, label: "Vellum Anthropic" },
        },
      )) as { name: string; isManaged: boolean };

      expect(result.isManaged).toBe(true);
    });

    test("returns isManaged: false after updating a user connection", async () => {
      seedConnection({
        name: "my-openai",
        provider: "openai",
        auth: { type: "api_key", credential: "ref/k" },
      });

      const result = (await call(
        findHandler("inference_provider_connections_update"),
        {
          pathParams: { name: "my-openai" },
          body: { auth: { type: "api_key", credential: "ref/k2" } },
        },
      )) as { name: string; isManaged: boolean };

      expect(result.isManaged).toBe(false);
    });
  });
});

// ── Auth / route-policy wiring ────────────────────────────────────────────────

describe("Route policy declarations", () => {
  test("GET list has settings.read policy", () => {
    const route = findRoute("inference_provider_connections_list");
    expect(route.policy).not.toBeNull();
    expect(route.policy!.requiredScopes).toContain("settings.read");
  });

  test("POST create has settings.write policy", () => {
    const route = findRoute("inference_provider_connections_create");
    expect(route.policy).not.toBeNull();
    expect(route.policy!.requiredScopes).toContain("settings.write");
  });

  test("GET single has settings.read policy", () => {
    const route = findRoute("inference_provider_connections_get");
    expect(route.policy).not.toBeNull();
    expect(route.policy!.requiredScopes).toContain("settings.read");
  });

  test("PATCH update has settings.write policy", () => {
    const route = findRoute("inference_provider_connections_update");
    expect(route.policy).not.toBeNull();
    expect(route.policy!.requiredScopes).toContain("settings.write");
  });

  test("DELETE has settings.write policy", () => {
    const route = findRoute("inference_provider_connections_delete");
    expect(route.policy).not.toBeNull();
    expect(route.policy!.requiredScopes).toContain("settings.write");
  });
});
