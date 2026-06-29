/**
 * Verifies that `GET /v1/config` enriches each profile in `llm.profiles`
 * with `supportsVision` resolved from the model catalog.
 */

import { describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "./helpers/mock-logger.js";

mock.module("../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

// ---------------------------------------------------------------------------
// Mocks for handleGetConfig's transitive deps
// ---------------------------------------------------------------------------

let rawConfig: Record<string, unknown> = {};

mock.module("../config/loader.js", () => ({
  loadRawConfig: () => structuredClone(rawConfig),
  saveRawConfig: () => {},
  deepMergeOverwrite: () => {},
  getConfig: () => rawConfig,
  getDeploymentContextDefaults: () => ({}),
  fillContextDefaultsForMissingKeys: () => {},
  invalidateConfigCache: () => {},
  setNestedValue: () => {},
}));

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

const configGetRoute = ROUTES.find((r) => r.operationId === "config_get")!;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /v1/config profile vision enrichment", () => {
  test("profile with a non-vision model gets supportsVision: false", () => {
    rawConfig = {
      llm: {
        profiles: {
          "test-no-vision": {
            provider: "fireworks",
            model: "accounts/fireworks/models/kimi-k2p5",
          },
        },
      },
    };

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
    rawConfig = {
      llm: {
        profiles: {
          "test-vision": {
            provider: "anthropic",
            model: "claude-opus-4-6",
          },
        },
      },
    };

    const result = configGetRoute.handler({}) as {
      llm?: {
        profiles?: Record<string, { supportsVision?: boolean }>;
      };
    };

    expect(result?.llm?.profiles?.["test-vision"]?.supportsVision).toBe(true);
  });

  test("profile with an unknown model defaults supportsVision to true (fail-open)", () => {
    rawConfig = {
      llm: {
        profiles: {
          "test-unknown": {
            provider: "anthropic",
            model: "some-unknown-model-xyz",
          },
        },
      },
    };

    const result = configGetRoute.handler({}) as {
      llm?: {
        profiles?: Record<string, { supportsVision?: boolean }>;
      };
    };

    expect(result?.llm?.profiles?.["test-unknown"]?.supportsVision).toBe(true);
  });

  test("profile without provider/model is left without supportsVision", () => {
    rawConfig = {
      llm: {
        profiles: {
          "test-empty": {},
        },
      },
    };

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
