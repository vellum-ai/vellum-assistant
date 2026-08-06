/**
 * Verifies that `GET /v1/config` stamps `usesVellumCredits` onto each profile
 * in `llm.profiles`: true when the profile dispatches through the
 * platform-billed managed route, false when it dispatches through the user's
 * own account (a BYOK key, a ChatGPT subscription), absent when the daemon
 * cannot establish it.
 *
 * The web chat reads this to decide whether an exhausted Vellum balance is
 * relevant to the next turn — a BYO chat must not be told to add credits.
 */

import { describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks for handleGetConfig's transitive deps
// ---------------------------------------------------------------------------

mock.module("../providers/registry.js", () => ({
  initializeProviders: async () => {},
}));

mock.module("../persistence/embeddings/embedding-backend.js", () => ({
  clearEmbeddingBackendCache: () => {},
}));

mock.module("../security/secret-allowlist.js", () => ({
  validateAllowlistFile: () => null,
}));

import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { providerConnections } from "../persistence/schema/index.js";
import { createConnection } from "../providers/inference/connections.js";
import { ROUTES } from "../runtime/routes/conversation-query-routes.js";
import { setConfig } from "./helpers/set-config.js";

await initializeDb();

const configGetRoute = ROUTES.find((r) => r.operationId === "config_get")!;

/** Seed `llm.profiles` into the real workspace config the handler reads. */
function seedProfiles(profiles: Record<string, unknown>): void {
  setConfig("llm", { profiles });
}

function creditsFlag(profileName: string): boolean | undefined {
  const result = configGetRoute.handler({}) as {
    llm?: { profiles?: Record<string, { usesVellumCredits?: boolean }> };
  };
  return result?.llm?.profiles?.[profileName]?.usesVellumCredits;
}

function seedConnection(input: {
  name: string;
  provider: string;
  auth: Record<string, unknown>;
}): void {
  getDb().delete(providerConnections).run();
  const created = createConnection(getDb(), input as never);
  if (!created.ok) {
    throw new Error(`failed to seed connection: ${JSON.stringify(created)}`);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /v1/config profile credits enrichment", () => {
  test("a profile on the managed connection is billed to Vellum credits", () => {
    seedProfiles({
      managed: {
        provider: "fireworks",
        model: "accounts/fireworks/models/glm-5p2",
        provider_connection: "vellum",
      },
    });

    expect(creditsFlag("managed")).toBe(true);
  });

  test("a profile on a BYOK connection is not billed to Vellum credits", () => {
    seedConnection({
      name: "openai-personal",
      provider: "openai",
      auth: { type: "api_key", credential: "credential/openai/api_key" },
    });
    seedProfiles({
      byok: {
        provider: "openai",
        model: "gpt-5.5",
        provider_connection: "openai-personal",
      },
    });

    expect(creditsFlag("byok")).toBe(false);
  });

  test("a ChatGPT-subscription profile is not billed to Vellum credits", () => {
    // The `chatgpt` routing identity overrides whatever connection the
    // profile stores, so the stale managed pin below must not win.
    seedConnection({
      name: "chatgpt-subscription",
      provider: "openai",
      auth: {
        type: "oauth_subscription",
        credential: "credential/openai/chatgpt-subscription",
      },
    });
    seedProfiles({
      subscription: {
        provider: "chatgpt",
        model: "gpt-5.3-codex",
        provider_connection: "vellum",
      },
    });

    expect(creditsFlag("subscription")).toBe(false);
  });

  test("a profile naming no connection is left unflagged", () => {
    seedProfiles({ unpinned: { provider: "openai", model: "gpt-5.5" } });

    expect(creditsFlag("unpinned")).toBeUndefined();
  });

  test("a profile naming a connection with no row is left unflagged", () => {
    getDb().delete(providerConnections).run();
    seedProfiles({
      dangling: {
        provider: "openai",
        model: "gpt-5.5",
        provider_connection: "deleted-connection",
      },
    });

    expect(creditsFlag("dangling")).toBeUndefined();
  });
});
