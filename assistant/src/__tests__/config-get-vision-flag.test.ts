/**
 * Verifies that `GET /v1/config` enriches each profile in `llm.profiles`
 * with `supportsVision` resolved from the model catalog.
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

import { ROUTES } from "../runtime/routes/conversation-query-routes.js";
import { setConfig } from "./helpers/set-config.js";

const configGetRoute = ROUTES.find((r) => r.operationId === "config_get")!;

/** Seed `llm.profiles` into the real workspace config the handler reads. */
function seedProfiles(profiles: Record<string, unknown>): void {
  setConfig("llm", { profiles });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /v1/config profile vision enrichment", () => {
  test("profile with a non-vision model gets supportsVision: false", () => {
    seedProfiles({
      "test-no-vision": {
        provider: "fireworks",
        model: "accounts/fireworks/models/kimi-k2p5",
      },
    });

    const result = configGetRoute.handler({}) as {
      llm?: {
        profiles?: Record<string, { supportsVision?: boolean }>;
      };
    };

    expect(result?.llm?.profiles?.["test-no-vision"]?.supportsVision).toBe(
      false,
    );
  });

  test("profile with a vision-capable model gets supportsVision: true", () => {
    seedProfiles({
      "test-vision": {
        provider: "anthropic",
        model: "claude-opus-4-6",
      },
    });

    const result = configGetRoute.handler({}) as {
      llm?: {
        profiles?: Record<string, { supportsVision?: boolean }>;
      };
    };

    expect(result?.llm?.profiles?.["test-vision"]?.supportsVision).toBe(true);
  });

  test("profile with an unknown model defaults supportsVision to true (fail-open)", () => {
    seedProfiles({
      "test-unknown": {
        provider: "anthropic",
        model: "some-unknown-model-xyz",
      },
    });

    const result = configGetRoute.handler({}) as {
      llm?: {
        profiles?: Record<string, { supportsVision?: boolean }>;
      };
    };

    expect(result?.llm?.profiles?.["test-unknown"]?.supportsVision).toBe(true);
  });

  test("profile without provider/model is left without supportsVision", () => {
    seedProfiles({
      "test-empty": {},
    });

    const result = configGetRoute.handler({}) as {
      llm?: {
        profiles?: Record<string, { supportsVision?: boolean }>;
      };
    };

    expect(
      result?.llm?.profiles?.["test-empty"]?.supportsVision,
    ).toBeUndefined();
  });
});
