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
let savedRawConfig: Record<string, unknown> | null = null;
let initializeProvidersCalls = 0;
mock.module("../../../config/loader.js", () => ({
  getConfig: () => structuredClone(savedRawConfig ?? fakeConfig),
  getConfigReadOnly: () => structuredClone(fakeConfig),
  loadRawConfig: () => structuredClone(fakeConfig),
  saveRawConfig: (raw: Record<string, unknown>) => {
    savedRawConfig = raw;
  },
  invalidateConfigCache: () => {},
}));

// commitConfigWrite (reached by the happy-path delete/active-set) reinitializes
// the provider registry and clears the embedding backend cache; stub both.
mock.module("../../../providers/registry.js", () => ({
  initializeProviders: async () => {
    initializeProvidersCalls += 1;
  },
}));

mock.module("../../../persistence/embeddings/embedding-backend.js", () => ({
  clearEmbeddingBackendCache: () => {},
}));

// ── Real imports (after mocks) ────────────────────────────────────────────────

import { getDb } from "../../../persistence/db-connection.js";
import { initializeDb } from "../../../persistence/db-init.js";
import { providerConnections } from "../../../persistence/schema/inference.js";
import { BadRequestError, ConflictError, NotFoundError } from "../errors.js";
import {
  collectProfileReferences,
  ROUTES,
} from "../inference-profiles-routes.js";
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
  savedRawConfig = null;
  initializeProvidersCalls = 0;
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

// ── delete reference guard (Finding 1) ────────────────────────────────────────

describe("collectProfileReferences", () => {
  test("detects each reference kind", () => {
    const llm = {
      activeProfile: "my-fast",
      advisorProfile: "my-fast",
      callSites: {
        memoryExtraction: { profile: "my-fast" },
        recall: { profile: "other" },
      },
      profiles: {
        "my-fast": { source: "user", provider: "anthropic" },
        "my-mix": {
          source: "user",
          mix: [{ profile: "my-fast", weight: 1 }],
        },
      },
    };
    expect(collectProfileReferences(llm, "my-fast").sort()).toEqual(
      [
        "llm.activeProfile",
        "llm.advisorProfile",
        "llm.callSites.memoryExtraction",
        "llm.profiles.my-mix.mix",
      ].sort(),
    );
  });

  test("returns empty for an unreferenced profile", () => {
    const llm = {
      activeProfile: "balanced",
      callSites: { recall: { profile: "balanced" } },
      profiles: { "my-fast": { source: "user", provider: "anthropic" } },
    };
    expect(collectProfileReferences(llm, "my-fast")).toEqual([]);
  });
});

describe("DELETE inference/profiles/:name reference guard", () => {
  test("rejects deletion referenced by activeProfile with the reference list", async () => {
    fakeConfig = {
      llm: {
        activeProfile: "my-fast",
        profiles: { "my-fast": { source: "user", provider: "anthropic" } },
      },
    };
    const promise = call("inference_profiles_delete", {
      pathParams: { name: "my-fast" },
    });
    await expect(promise).rejects.toBeInstanceOf(ConflictError);
    await expect(promise).rejects.toThrow(/llm\.activeProfile/);
    expect(initializeProvidersCalls).toBe(0);
  });

  test("rejects deletion referenced by a mix arm", async () => {
    fakeConfig = {
      llm: {
        profiles: {
          "my-fast": { source: "user", provider: "anthropic" },
          "my-mix": {
            source: "user",
            mix: [{ profile: "my-fast", weight: 1 }],
          },
        },
      },
    };
    await expect(
      call("inference_profiles_delete", { pathParams: { name: "my-fast" } }),
    ).rejects.toThrow(/llm\.profiles\.my-mix\.mix/);
  });

  test("rejects deletion referenced by a call site", async () => {
    fakeConfig = {
      llm: {
        callSites: { memoryExtraction: { profile: "my-fast" } },
        profiles: { "my-fast": { source: "user", provider: "anthropic" } },
      },
    };
    await expect(
      call("inference_profiles_delete", { pathParams: { name: "my-fast" } }),
    ).rejects.toThrow(/llm\.callSites\.memoryExtraction/);
  });

  test("deletes an unreferenced custom profile", async () => {
    fakeConfig = {
      llm: {
        activeProfile: "balanced",
        profiles: { "my-fast": { source: "user", provider: "anthropic" } },
      },
    };
    const result = (await call("inference_profiles_delete", {
      pathParams: { name: "my-fast" },
    })) as { ok: true; name: string };
    expect(result).toEqual({ ok: true, name: "my-fast" });
    expect(savedRawConfig?.llm).toBeDefined();
    expect(
      (savedRawConfig?.llm as { profiles?: Record<string, unknown> }).profiles,
    ).toEqual({});
    expect(initializeProvidersCalls).toBe(1);
  });
});

// ── provider-aware list/get (Finding 2) ───────────────────────────────────────

describe("GET inference/profiles honors llm.defaultProvider", () => {
  test("expands balanced through a BYOK default provider, not the vellum column", async () => {
    fakeConfig = {
      llm: {
        defaultProvider: { provider: "anthropic" },
        profiles: {},
      },
    };
    const listed = (await call("inference_profiles_list", {})) as {
      profiles: Array<{ name: string; provider: string | null }>;
    };
    const balanced = listed.profiles.find((p) => p.name === "balanced");
    expect(balanced).toBeDefined();
    // The vellum column implements `balanced` on fireworks; with a BYOK
    // anthropic default provider the CLI must report anthropic instead.
    expect(balanced!.provider).toBe("anthropic");

    const got = (await call("inference_profiles_get", {
      pathParams: { name: "balanced" },
    })) as { entry: { provider?: string } };
    expect(got.entry.provider).toBe("anthropic");
  });
});

// ── active-profile setter validation (Finding 3) ──────────────────────────────

describe("PUT inference/active-profile validation", () => {
  test("sets a valid profile", async () => {
    fakeConfig = {
      llm: {
        profiles: {
          "my-fast": {
            source: "user",
            provider: "anthropic",
            model: "claude-opus-4-8",
            status: "active",
          },
        },
      },
    };
    const result = (await call("inference_profiles_set_active", {
      body: { name: "my-fast" },
    })) as { ok: true; activeProfile: string };
    expect(result).toEqual({ ok: true, activeProfile: "my-fast" });
    expect(
      (savedRawConfig?.llm as { activeProfile?: string }).activeProfile,
    ).toBe("my-fast");
  });

  test("rejects a typo'd name with the valid-name list", async () => {
    fakeConfig = { llm: { profiles: {} } };
    const promise = call("inference_profiles_set_active", {
      body: { name: "balancd" },
    });
    await expect(promise).rejects.toBeInstanceOf(BadRequestError);
    // The error names the real defaults so the user can correct the typo.
    await expect(promise).rejects.toThrow(/balanced/);
    expect(initializeProvidersCalls).toBe(0);
  });

  test("rejects a disabled profile", async () => {
    fakeConfig = {
      llm: {
        profiles: {
          "my-fast": {
            source: "user",
            provider: "anthropic",
            model: "claude-opus-4-8",
            status: "disabled",
          },
        },
      },
    };
    await expect(
      call("inference_profiles_set_active", { body: { name: "my-fast" } }),
    ).rejects.toThrow(/disabled/);
  });
});
