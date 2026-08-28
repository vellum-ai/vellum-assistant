import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";
import OpenAI from "openai";

import type { DrizzleDb } from "../../persistence/db-connection.js";
import { migrateCreateProviderConnections } from "../../persistence/migrations/243-provider-connections.js";
import { migrateProviderConnectionStatusLabel } from "../../persistence/migrations/244-provider-connection-status-label.js";
import { migrateProviderConnectionBaseUrlAndModels } from "../../persistence/migrations/250-provider-connection-base-url-and-models.js";
import * as schema from "../../persistence/schema/index.js";
import { ProviderError } from "../../util/errors.js";
import { FireworksProvider } from "../fireworks/client.js";
import { createAdapterFromConnection } from "../inference/adapter-factory.js";
import type { Auth, ProviderConnection } from "../inference/auth.js";
import type { ResolvedAuth } from "../inference/auth.js";
import { effectiveConnectionAuth } from "../inference/auth.js";
import {
  createConnection,
  getConnection,
  listConnections,
} from "../inference/connections.js";
import type { Provider } from "../types.js";
import { isVellumManagedConnection } from "../vellum-model-routing.js";

const HOSTED_PREFLIGHT =
  "Model 'qwen/qwen3-8b' is not yet supported on the Vellum hosted service.";

function hostedPreflightError(): InstanceType<typeof OpenAI.APIError> {
  return new OpenAI.APIError(
    400,
    { detail: HOSTED_PREFLIGHT },
    HOSTED_PREFLIGHT,
    new Headers(),
  );
}

function unwrapAdapter(provider: Provider): object {
  let current: object = provider;
  while ("inner" in current && (current as { inner?: object }).inner) {
    current = (current as { inner: object }).inner;
  }
  return current;
}

function stubChatCompletionsError(provider: object, error: unknown): void {
  (provider as { client: unknown }).client = {
    chat: {
      completions: {
        create: async () => {
          throw error;
        },
      },
    },
  };
}

async function sendAndCatch(provider: Provider): Promise<unknown> {
  return provider
    .sendMessage([{ role: "user", content: [{ type: "text", text: "hi" }] }])
    .then(
      () => null,
      (error: unknown) => error,
    );
}

function setupDb(): DrizzleDb {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  const db = drizzle(sqlite, { schema });
  migrateCreateProviderConnections(db);
  migrateProviderConnectionStatusLabel(db);
  migrateProviderConnectionBaseUrlAndModels(db);
  return db;
}

const vellumConnection = {
  name: "vellum",
  provider: "vellum",
  auth: { type: "platform" },
  label: "Vellum",
} as unknown as ProviderConnection;

const resolvedAuth: ResolvedAuth = {
  kind: "header",
  headers: { Authorization: "Bearer test-key" },
  baseUrl: "https://platform.example/v1/runtime-proxy/fireworks",
};

describe("vellum connection routing", () => {
  test("isVellumManagedConnection identifies the sentinel connection", () => {
    expect(isVellumManagedConnection(vellumConnection)).toBe(true);
    // The provider column alone decides: a concrete provider is never the
    // managed route (platform auth always pairs with provider "vellum";
    // DB migration 361 reconciles stored rows).
    expect(isVellumManagedConnection({ provider: "fireworks" })).toBe(false);
    expect(isVellumManagedConnection({ provider: "vellum" })).toBe(true);
  });

  test("the vellum sentinel does not dispatch without an override", () => {
    // No `provider` override → the connection column is the routing
    // sentinel and must not build an adapter, even though Vellum-hosted
    // GPU models share this catalog id.
    const adapter = createAdapterFromConnection(
      vellumConnection,
      resolvedAuth,
      {
        model: "accounts/fireworks/models/kimi-k2p5",
      },
    );
    expect(adapter).toBeNull();
  });

  test("provider override routes the vellum connection to the real upstream", () => {
    const adapter = createAdapterFromConnection(
      vellumConnection,
      resolvedAuth,
      {
        model: "accounts/fireworks/models/kimi-k2p5",
        provider: "fireworks",
      },
    );
    expect(adapter).not.toBeNull();
  });

  test("provider override vellum routes GPU models through VellumProvider", () => {
    const adapter = createAdapterFromConnection(
      vellumConnection,
      {
        kind: "header",
        headers: { Authorization: "Bearer test-key" },
        baseUrl: "https://platform.example/v1/runtime-proxy/vellum",
      },
      {
        model: "qwen/qwen3-8b",
        provider: "vellum",
      },
    );
    expect(adapter).not.toBeNull();
    expect(adapter?.name).toBe("vellum");
  });

  test("Vellum-managed fireworks override labels API errors as Vellum", async () => {
    const adapter = createAdapterFromConnection(
      vellumConnection,
      resolvedAuth,
      {
        model: "qwen/qwen3-8b",
        provider: "fireworks",
      },
    );
    expect(adapter).not.toBeNull();
    stubChatCompletionsError(unwrapAdapter(adapter!), hostedPreflightError());
    const thrown = await sendAndCatch(adapter!);
    expect(thrown).toBeInstanceOf(ProviderError);
    expect((thrown as ProviderError).message).toBe(
      `Vellum API error (400): ${HOSTED_PREFLIGHT}`,
    );
  });

  test("direct FireworksProvider keeps the Fireworks error prefix", async () => {
    const provider = new FireworksProvider("test-key", "qwen/qwen3-8b");
    stubChatCompletionsError(provider, hostedPreflightError());
    const thrown = await sendAndCatch(provider);
    expect(thrown).toBeInstanceOf(ProviderError);
    expect((thrown as ProviderError).message).toBe(
      `Fireworks API error (400): ${HOSTED_PREFLIGHT}`,
    );
  });
});

describe("effectiveConnectionAuth", () => {
  test("a vellum row dispatches on platform auth regardless of the stored variant", () => {
    for (const stored of [
      { type: "api_key", credential: "vault/x" },
      { type: "none" },
      { type: "platform" },
    ] as Auth[]) {
      expect(
        effectiveConnectionAuth({ provider: "vellum", auth: stored }),
      ).toEqual({ type: "platform" });
    }
  });

  test("payload-carrying rows keep their stored auth verbatim", () => {
    const keyed: Auth = { type: "api_key", credential: "vault/anthropic" };
    expect(
      effectiveConnectionAuth({ provider: "anthropic", auth: keyed }),
    ).toBe(keyed);
    const subscription: Auth = { type: "oauth_subscription" } as Auth;
    expect(
      effectiveConnectionAuth({ provider: "openai", auth: subscription }),
    ).toBe(subscription);
  });

  test("a deliberately keyed keyless provider keeps its key", () => {
    // Keyless means no key REQUIRED, not no key possible: the ollama adapter
    // accepts one, so stored api_key auth on an ollama row is payload and
    // must never be derived away.
    const keyed: Auth = { type: "api_key", credential: "vault/ollama" };
    expect(effectiveConnectionAuth({ provider: "ollama", auth: keyed })).toBe(
      keyed,
    );
  });
});

describe("vellum connection persistence (DB round-trip)", () => {
  // Guards the P1: a persisted `provider: "vellum"` row must survive the DB
  // loaders and create route, which validate against VALID_CONNECTION_PROVIDERS.
  // Without the sentinel on that allowlist these all reject the row and the
  // routing above never runs on a real config.
  test("createConnection accepts a vellum sentinel row", () => {
    const db = setupDb();
    const result = createConnection(db, {
      name: "vellum",
      provider: "vellum",
      auth: { type: "platform" },
      label: "Vellum",
    });
    expect(result.ok).toBe(true);
  });

  test("getConnection loads a persisted vellum row (not dropped as invalid)", () => {
    const db = setupDb();
    createConnection(db, {
      name: "vellum",
      provider: "vellum",
      auth: { type: "platform" },
    });
    const loaded = getConnection(db, "vellum");
    expect(loaded).not.toBeNull();
    expect(loaded?.provider).toBe("vellum");
    expect(isVellumManagedConnection(loaded!)).toBe(true);
  });

  test("listConnections includes a persisted vellum row", () => {
    const db = setupDb();
    createConnection(db, {
      name: "vellum",
      provider: "vellum",
      auth: { type: "platform" },
    });
    const names = listConnections(db).map((c) => c.name);
    expect(names).toContain("vellum");
  });
});
