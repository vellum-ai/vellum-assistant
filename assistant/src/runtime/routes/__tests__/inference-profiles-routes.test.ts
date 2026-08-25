/**
 * Tests for the inference-profile route handlers' write-time validation.
 *
 * Covers the guardrails that distinguish these routes from the generic
 * `config set llm.profiles.*` path:
 *   - bad provider (not in the LLMProvider enum)
 *   - uncataloged model without --allow-unlisted
 *   - missing provider connection
 *   - managed-profile create / update / delete rejection
 *   - the dispatch-availability guard on create / update / set-active
 *
 * Routing-identity creates exercise the happy-path write end-to-end (through
 * `commitConfigWrite` with the registry reinit stubbed); other happy-path
 * writes are covered by the config-write tests.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Module mocks (must come before imports) ──────────────────────────────────

let initializeProvidersCalls = 0;

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

// The availability guard judges the Vellum-managed route and the credential
// store for real; both are stood in for here so tests can pick a state.
let managedProxyEnabled = true;
mock.module("../../../providers/platform-proxy/context.js", () => ({
  resolveManagedProxyContext: async () => ({
    enabled: managedProxyEnabled,
    platformBaseUrl: "https://platform.example",
    assistantApiKey: managedProxyEnabled ? "key" : "",
  }),
}));

let secureKeyResult: { value: string | undefined; unreachable: boolean } = {
  value: "test-key",
  unreachable: false,
};
mock.module("../../../security/secure-keys.js", () => ({
  getSecureKeyResultAsync: async () => secureKeyResult,
}));

// commitConfigWrite notifies clients after every successful write so their
// config views (e.g. the chat composer's model pill) refetch without a manual
// refresh; counted here so tests can assert the notification fired.
let configChangedPublishes = 0;
mock.module("../../sync/resource-sync-events.js", () => ({
  publishConfigChanged: () => {
    configChangedPublishes += 1;
  },
}));

// ── Real imports (after mocks) ────────────────────────────────────────────────

import { setConfig } from "../../../__tests__/helpers/set-config.js";
import { loadRawConfig } from "../../../config/loader.js";
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

function seedConnection(
  name: string,
  provider: string,
  auth: object = { type: "none" },
): void {
  const now = Date.now();
  getDb()
    .insert(providerConnections)
    .values({
      name,
      provider,
      auth: JSON.stringify(auth),
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

/** A credentialed API-key connection — the healthy BYO shape. */
function seedKeyedConnection(provider: string): void {
  seedConnection(`${provider}-personal`, provider, {
    type: "api_key",
    credential: `credential/${provider}/api_key`,
  });
}

/** The Vellum-managed row every routing-identity profile resolves to. */
function seedVellumConnection(): void {
  seedConnection("vellum", "vellum", { type: "platform" });
}

function persistedProfiles(): Record<string, unknown> {
  const llm = loadRawConfig().llm as
    | { profiles?: Record<string, unknown> }
    | undefined;
  return llm?.profiles ?? {};
}

beforeEach(() => {
  getDb().delete(providerConnections).run();
  setConfig("llm", {});
  initializeProvidersCalls = 0;
  managedProxyEnabled = true;
  secureKeyResult = { value: "test-key", unreachable: false };
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

  test("creates an entry-backed profile, validating the model by the row's kind", async () => {
    seedConnection("anthropic-work", "anthropic", {
      type: "api_key",
      credential: "credential/anthropic-work/api_key",
    });
    const result = (await call("inference_profiles_create", {
      body: {
        name: "work-profile",
        provider: "anthropic-work",
        model: "claude-opus-4-8",
      },
    })) as { entry: Record<string, unknown> };
    expect(result.entry.provider).toBe("anthropic-work");
    expect(result.entry.model).toBe("claude-opus-4-8");
  });

  test("rejects an entry-backed profile whose model the row's kind cannot serve", async () => {
    seedConnection("anthropic-work", "anthropic", {
      type: "api_key",
      credential: "credential/anthropic-work/api_key",
    });
    await expect(
      call("inference_profiles_create", {
        body: {
          name: "work-profile",
          provider: "anthropic-work",
          model: "gpt-5.5",
        },
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  test("rejects a provider naming no known vendor or entry", async () => {
    await expect(
      call("inference_profiles_create", {
        body: {
          name: "ghost-profile",
          provider: "no-such-entry",
          model: "claude-opus-4-8",
        },
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  test("creates a vellum profile for a managed-routable model", async () => {
    seedVellumConnection();
    const result = (await call("inference_profiles_create", {
      body: {
        name: "my-managed",
        provider: "vellum",
        model: "claude-opus-4-8",
      },
    })) as { entry: Record<string, unknown>; verify: string };
    expect(result.entry.provider).toBe("vellum");
    expect(result.entry.model).toBe("claude-opus-4-8");
    expect(result.verify).toBe(
      'assistant inference send --profile my-managed "Reply with OK"',
    );
    expect(loadRawConfig().llm).toMatchObject({
      profiles: { "my-managed": { provider: "vellum" } },
    });
  });

  test("rejects a vellum profile whose maxTokens exceeds the routed model's limits", async () => {
    seedVellumConnection();
    await expect(
      call("inference_profiles_create", {
        body: {
          name: "my-managed-big",
          provider: "vellum",
          model: "claude-opus-4-8",
          maxTokens: 999999999,
        },
      }),
    ).rejects.toThrow(/maxTokens/);
  });

  test("rejects a vellum profile whose model has no managed upstream", async () => {
    await expect(
      call("inference_profiles_create", {
        body: {
          name: "my-managed",
          provider: "vellum",
          model: "not-a-real-model",
        },
      }),
    ).rejects.toThrow(
      /"not-a-real-model" is not served by the Vellum managed route/,
    );
  });

  test("rejects a vellum profile with an encoded routing string as its model", async () => {
    await expect(
      call("inference_profiles_create", {
        body: {
          name: "my-managed",
          provider: "vellum",
          model: "fireworks/accounts/fireworks/models/glm-5p2",
        },
      }),
    ).rejects.toThrow(/encoded routing string/);
  });

  test("creates a chatgpt profile for a Codex model", async () => {
    seedConnection("chatgpt-subscription", "openai", {
      type: "oauth_subscription",
      credential: "credential/chatgpt/access_token",
    });
    const result = (await call("inference_profiles_create", {
      body: {
        name: "my-subscription",
        provider: "chatgpt",
        model: "gpt-5.5",
      },
    })) as { entry: Record<string, unknown> };
    expect(result.entry.provider).toBe("chatgpt");
  });

  test("rejects a chatgpt profile with a non-Codex model", async () => {
    await expect(
      call("inference_profiles_create", {
        body: {
          name: "my-subscription",
          provider: "chatgpt",
          model: "gpt-5",
        },
      }),
    ).rejects.toThrow(/Codex models only/);
  });

  test("defaults the label to the catalog display name when omitted", async () => {
    seedKeyedConnection("gemini");
    const result = (await call("inference_profiles_create", {
      body: {
        name: "gemini-latest",
        provider: "gemini",
        model: "gemini-3.6-flash",
      },
    })) as { ok: true; entry: Record<string, unknown> };
    expect(result.entry.label).toBe("Gemini 3.6 Flash");
  });

  test("keeps an explicit label over the catalog display name", async () => {
    seedKeyedConnection("gemini");
    const result = (await call("inference_profiles_create", {
      body: {
        name: "my-fast-gemini",
        provider: "gemini",
        model: "gemini-3.6-flash",
        label: "My Fast Model",
      },
    })) as { ok: true; entry: Record<string, unknown> };
    expect(result.entry.label).toBe("My Fast Model");
  });

  test("accepts a model advertised by the named connection", async () => {
    getDb()
      .insert(providerConnections)
      .values({
        name: "stub-local",
        provider: "openai-compatible",
        auth: JSON.stringify({ type: "none" }),
        baseUrl: "http://localhost:9123/v1",
        models: JSON.stringify([{ id: "stub-model" }]),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .onConflictDoNothing()
      .run();
    const result = (await call("inference_profiles_create", {
      body: {
        name: "stub-fast",
        provider: "openai-compatible",
        model: "stub-model",
        connection: "stub-local",
      },
    })) as { ok: true; warnings: string[] };
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
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

// ── write-time availability guard ─────────────────────────────────────────────

describe("inference-profile writes are availability-aware", () => {
  const geminiBody = {
    name: "gemini-latest",
    provider: "gemini",
    model: "gemini-3.6-flash",
  };

  test("rejects a BYO provider with no connection and names the managed alternative", async () => {
    const promise = call("inference_profiles_create", { body: geminiBody });
    await expect(promise).rejects.toBeInstanceOf(BadRequestError);
    await expect(promise).rejects.toThrow(
      /Provider "gemini" is a valid provider id, but no gemini connection\/API key is configured/,
    );
    await expect(promise).rejects.toThrow(
      /Recreate with --provider vellum --model gemini-3\.6-flash/,
    );
    await expect(promise).rejects.toThrow(/allowUnavailable/);
    expect(persistedProfiles()).toEqual({});
  });

  test("falls back to the credential sequence when the managed route is unusable", async () => {
    managedProxyEnabled = false;
    secureKeyResult = { value: undefined, unreachable: false };
    const promise = call("inference_profiles_create", { body: geminiBody });
    await expect(promise).rejects.toThrow(
      /assistant credentials prompt --service gemini --field api_key/,
    );
    await expect(promise).rejects.toThrow(
      /assistant inference providers create gemini-personal --provider gemini --credential credential\/gemini\/api_key/,
    );
    await expect(promise).rejects.toThrow(/never ask for the key in chat/);
    expect(persistedProfiles()).toEqual({});
  });

  test("missing credential on an existing connection suggests key collection only", async () => {
    managedProxyEnabled = false;
    seedKeyedConnection("gemini");
    secureKeyResult = { value: undefined, unreachable: false };
    const promise = call("inference_profiles_create", { body: geminiBody });
    await expect(promise).rejects.toThrow(
      /assistant credentials prompt --service gemini --field api_key/,
    );
    // The connection already exists — a `providers create` would collide.
    await expect(promise).rejects.not.toThrow(/inference providers create/);
    expect(persistedProfiles()).toEqual({});
  });

  test("shell-quotes profile names in generated commands", async () => {
    setConfig("llm", {
      profiles: {
        "my profile; echo x": {
          source: "user",
          provider: "gemini",
          model: "gemini-3.6-flash",
          status: "active",
        },
      },
    });
    const promise = call("inference_profiles_set_active", {
      body: { name: "my profile; echo x" },
    });
    await expect(promise).rejects.toThrow(
      /--profile 'my profile; echo x' "Reply with OK"/,
    );
  });

  test("allowUnavailable writes the profile and warns instead", async () => {
    const result = (await call("inference_profiles_create", {
      body: { ...geminiBody, allowUnavailable: true },
    })) as { warnings: string[]; verify: string };
    expect(result.warnings.join(" ")).toMatch(
      /cannot serve requests yet \(missing_connection\)/,
    );
    expect(result.verify).toBe(
      'assistant inference send --profile gemini-latest "Reply with OK"',
    );
    expect(persistedProfiles()).toHaveProperty("gemini-latest");
  });

  test("an unreachable credential store does not block the write", async () => {
    // `unknown` means the credential could not be verified, not that it is
    // absent — blocking here would punish a CES outage.
    seedKeyedConnection("gemini");
    secureKeyResult = { value: undefined, unreachable: true };
    const result = (await call("inference_profiles_create", {
      body: geminiBody,
    })) as { warnings: string[] };
    expect(result.warnings).toEqual([]);
    expect(persistedProfiles()).toHaveProperty("gemini-latest");
  });

  test("accepts a BYO provider once a credentialed connection exists", async () => {
    seedKeyedConnection("gemini");
    const result = (await call("inference_profiles_create", {
      body: geminiBody,
    })) as { warnings: string[]; verify: string };
    expect(result.warnings).toEqual([]);
    expect(result.verify).toBe(
      'assistant inference send --profile gemini-latest "Reply with OK"',
    );
  });

  test("rejects an update that leaves the profile unable to dispatch", async () => {
    seedKeyedConnection("anthropic");
    setConfig("llm", {
      profiles: {
        "my-fast": {
          source: "user",
          provider: "anthropic",
          model: "claude-opus-4-8",
        },
      },
    });
    const promise = call("inference_profiles_update", {
      pathParams: { name: "my-fast" },
      body: { provider: "gemini", model: "gemini-3.6-flash" },
    });
    await expect(promise).rejects.toBeInstanceOf(BadRequestError);
    await expect(promise).rejects.toThrow(
      /Update it with --provider vellum --model gemini-3\.6-flash/,
    );
    expect(persistedProfiles()).toMatchObject({
      "my-fast": { provider: "anthropic" },
    });
  });

  test("a metadata-only update skips the availability guard", async () => {
    setConfig("llm", {
      profiles: {
        "my-gemini": {
          source: "user",
          provider: "gemini",
          model: "gemini-3.6-flash",
        },
      },
    });
    const result = (await call("inference_profiles_update", {
      pathParams: { name: "my-gemini" },
      body: { label: "Pre-staged Gemini" },
    })) as { ok: true; warnings: string[] };
    expect(result.ok).toBe(true);
    expect(persistedProfiles()).toMatchObject({
      "my-gemini": { label: "Pre-staged Gemini", provider: "gemini" },
    });
  });

  test("a healthy update returns the verify command", async () => {
    seedKeyedConnection("anthropic");
    setConfig("llm", {
      profiles: {
        "my-fast": {
          source: "user",
          provider: "anthropic",
          model: "claude-opus-4-8",
        },
      },
    });
    const result = (await call("inference_profiles_update", {
      pathParams: { name: "my-fast" },
      body: { effort: "low" },
    })) as { verify: string };
    expect(result.verify).toBe(
      'assistant inference send --profile my-fast "Reply with OK"',
    );
  });
});

// ── update validation ─────────────────────────────────────────────────────────

describe("PATCH inference/profiles/:name (update) validation", () => {
  test("rejects editing a managed default profile", async () => {
    setConfig("llm", {
      profiles: {
        balanced: {
          source: "managed",
          provider: "fireworks",
          model: "accounts/fireworks/models/glm-5p2",
        },
      },
    });
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
    setConfig("llm", { profiles: { balanced: { source: "managed" } } });
    await expect(
      call("inference_profiles_delete", { pathParams: { name: "balanced" } }),
    ).rejects.toThrow(/managed profile/);
  });

  test("404s an unknown profile", async () => {
    setConfig("llm", { profiles: {} });
    await expect(
      call("inference_profiles_delete", { pathParams: { name: "ghost" } }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ── duplicate create ──────────────────────────────────────────────────────────

describe("POST inference/profiles create conflict", () => {
  test("409s when a profile with the name already exists", async () => {
    seedConnection("anthropic-personal", "anthropic");
    setConfig("llm", {
      profiles: { existing: { source: "user", provider: "anthropic" } },
    });
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
    setConfig("llm", {
      activeProfile: "my-fast",
      profiles: { "my-fast": { source: "user", provider: "anthropic" } },
    });
    const promise = call("inference_profiles_delete", {
      pathParams: { name: "my-fast" },
    });
    await expect(promise).rejects.toBeInstanceOf(ConflictError);
    await expect(promise).rejects.toThrow(/llm\.activeProfile/);
    expect(initializeProvidersCalls).toBe(0);
  });

  test("rejects deletion referenced by a mix arm", async () => {
    setConfig("llm", {
      profiles: {
        "my-fast": { source: "user", provider: "anthropic" },
        "my-mix": {
          source: "user",
          mix: [{ profile: "my-fast", weight: 1 }],
        },
      },
    });
    await expect(
      call("inference_profiles_delete", { pathParams: { name: "my-fast" } }),
    ).rejects.toThrow(/llm\.profiles\.my-mix\.mix/);
  });

  test("rejects deletion referenced by a call site", async () => {
    setConfig("llm", {
      callSites: { memoryExtraction: { profile: "my-fast" } },
      profiles: { "my-fast": { source: "user", provider: "anthropic" } },
    });
    await expect(
      call("inference_profiles_delete", { pathParams: { name: "my-fast" } }),
    ).rejects.toThrow(/llm\.callSites\.memoryExtraction/);
  });

  test("deletes an unreferenced custom profile", async () => {
    setConfig("llm", {
      activeProfile: "balanced",
      profiles: { "my-fast": { source: "user", provider: "anthropic" } },
    });
    const result = (await call("inference_profiles_delete", {
      pathParams: { name: "my-fast" },
    })) as { ok: true; name: string };
    expect(result).toEqual({ ok: true, name: "my-fast" });
    expect(loadRawConfig().llm).toBeDefined();
    expect(
      (loadRawConfig().llm as { profiles?: Record<string, unknown> }).profiles,
    ).toEqual({});
    expect(initializeProvidersCalls).toBe(1);
  });
});

// ── provider-aware list/get (Finding 2) ───────────────────────────────────────

describe("GET inference/profiles honors llm.defaultProvider", () => {
  test("expands balanced through a BYOK default provider, not the vellum column", async () => {
    setConfig("llm", {
      defaultProvider: { provider: "anthropic" },
      profiles: {},
    });
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

describe("POST inference/profiles/:name/validate billing guards", () => {
  test("gives no verdict for a mix whose winning arm rides the managed route", async () => {
    seedVellumConnection();
    setConfig("llm", {
      profiles: {
        "managed-arm": { provider: "vellum", model: "claude-opus-4-8" },
        "my-mix": {
          mix: [
            { profile: "managed-arm", weight: 1 },
            { profile: "managed-arm", weight: 1 },
          ],
        },
      },
    });
    const result = (await call("inference_profiles_validate", {
      pathParams: { name: "my-mix" },
    })) as { check: unknown };
    expect(result.check).toBeNull();
  });

  test("gives no verdict when a call-site override routes the probe onto the managed identity", async () => {
    seedVellumConnection();
    setConfig("llm", {
      profiles: {
        "my-byok": { provider: "openai", model: "gpt-5.2" },
      },
      callSites: {
        inference: { provider: "vellum", model: "claude-opus-4-8" },
      },
    });
    const result = (await call("inference_profiles_validate", {
      pathParams: { name: "my-byok" },
    })) as { check: unknown };
    expect(result.check).toBeNull();
  });
});

describe("GET inference/profiles config_issue verdict", () => {
  test("flags a stored profile whose model the provider does not serve", async () => {
    seedConnection("anthropic-personal", "anthropic", {
      type: "api_key",
      credential: "credential/anthropic/api_key",
    });
    setConfig("llm", {
      profiles: {
        busted: { provider: "anthropic", model: "bub bub" },
        fine: { provider: "anthropic", model: "claude-opus-4-8" },
      },
    });
    const result = (await call("inference_profiles_list", {})) as {
      profiles: Array<{
        name: string;
        config_issue?: { code: string; message: string };
      }>;
    };
    const busted = result.profiles.find((p) => p.name === "busted");
    expect(busted?.config_issue?.code).toBe("model_unknown");
    expect(busted?.config_issue?.message).toContain("bub bub");
    const fine = result.profiles.find((p) => p.name === "fine");
    expect(fine?.config_issue).toBeUndefined();
  });

  test("flags an impossible stored token budget and mirrors on the detail route", async () => {
    setConfig("llm", {
      profiles: {
        overweight: {
          provider: "anthropic",
          model: "claude-opus-4-8",
          maxTokens: 999999999,
        },
      },
    });
    const detail = (await call("inference_profiles_get", {
      pathParams: { name: "overweight" },
    })) as { config_issue?: { code: string } };
    expect(detail.config_issue?.code).toBe("over_output_cap");
  });

  test("does not flag a deliberately allowUnlisted profile", async () => {
    seedConnection("anthropic-personal", "anthropic", {
      type: "api_key",
      credential: "credential/anthropic/api_key",
    });
    await call("inference_profiles_create", {
      body: {
        name: "early-adopter",
        provider: "anthropic",
        model: "claude-6-preview",
        connection: "anthropic-personal",
        allowUnlisted: true,
        allowUnavailable: true,
      },
    });
    const result = (await call("inference_profiles_list", {})) as {
      profiles: Array<{
        name: string;
        config_issue?: { code: string };
      }>;
    };
    const row = result.profiles.find((p) => p.name === "early-adopter");
    expect(row?.config_issue).toBeUndefined();
  });
});

describe("PUT inference/active-profile validation", () => {
  test("sets a valid profile", async () => {
    seedKeyedConnection("anthropic");
    setConfig("llm", {
      profiles: {
        "my-fast": {
          source: "user",
          provider: "anthropic",
          model: "claude-opus-4-8",
          status: "active",
        },
      },
    });
    const publishesBefore = configChangedPublishes;
    const result = (await call("inference_profiles_set_active", {
      body: { name: "my-fast" },
    })) as { ok: true; activeProfile: string };
    expect(result).toEqual({ ok: true, activeProfile: "my-fast" });
    expect(
      (loadRawConfig().llm as { activeProfile?: string }).activeProfile,
    ).toBe("my-fast");
    // Clients are notified so their config views (composer model pill,
    // Settings) refetch without a manual refresh.
    expect(configChangedPublishes).toBe(publishesBefore + 1);
  });

  test("rejects a typo'd name with the valid-name list", async () => {
    setConfig("llm", { profiles: {} });
    const promise = call("inference_profiles_set_active", {
      body: { name: "balancd" },
    });
    await expect(promise).rejects.toBeInstanceOf(BadRequestError);
    // The error names the real defaults so the user can correct the typo.
    await expect(promise).rejects.toThrow(/balanced/);
    expect(initializeProvidersCalls).toBe(0);
  });

  test("rejects a disabled profile", async () => {
    setConfig("llm", {
      profiles: {
        "my-fast": {
          source: "user",
          provider: "anthropic",
          model: "claude-opus-4-8",
          status: "disabled",
        },
      },
    });
    await expect(
      call("inference_profiles_set_active", { body: { name: "my-fast" } }),
    ).rejects.toThrow(/disabled/);
  });

  test("rejects a profile that cannot serve requests — no escape hatch", async () => {
    setConfig("llm", {
      profiles: {
        "my-gemini": {
          source: "user",
          provider: "gemini",
          model: "gemini-3.6-flash",
          status: "active",
        },
      },
    });
    const promise = call("inference_profiles_set_active", {
      body: { name: "my-gemini", allowUnavailable: true },
    });
    await expect(promise).rejects.toBeInstanceOf(BadRequestError);
    await expect(promise).rejects.toThrow(
      /no gemini connection\/API key is configured/,
    );
    await expect(promise).rejects.toThrow(
      /assistant inference profiles update my-gemini --provider vellum --model gemini-3\.6-flash/,
    );
    await expect(promise).rejects.toThrow(
      /assistant inference send --profile my-gemini "Reply with OK"/,
    );
    expect(
      (loadRawConfig().llm as { activeProfile?: string }).activeProfile,
    ).toBeUndefined();
  });

  test("allows a profile whose availability is indeterminate", async () => {
    seedKeyedConnection("gemini");
    secureKeyResult = { value: undefined, unreachable: true };
    setConfig("llm", {
      profiles: {
        "my-gemini": {
          source: "user",
          provider: "gemini",
          model: "gemini-3.6-flash",
          status: "active",
        },
      },
    });
    const result = (await call("inference_profiles_set_active", {
      body: { name: "my-gemini" },
    })) as { ok: true; activeProfile: string };
    expect(result).toEqual({ ok: true, activeProfile: "my-gemini" });
  });
});
