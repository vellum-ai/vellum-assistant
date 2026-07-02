/**
 * Tests the two layers protecting managed inference profiles:
 *
 * - Route-level managed guards: managed profiles can't be deleted via PATCH
 *   and the PUT profile route restricts them to the label/status/topP
 *   allowlist.
 * - The commitConfigWrite invariant guard: the default profiles
 *   ("quality-optimized", "balanced", "cost-optimized") are fully read-only
 *   across PATCH/SET/PUT — the only writable transition is re-enabling a
 *   disabled default.
 *
 * Plus the wire-only profile keys (`invariant`, `supportsVision`) stamped on
 * config reads: PATCH/SET strip them so a GET → write round-trip succeeds.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Imported before the `mock.module` below so the mock can pass the real
// implementation through instead of hand-copying it.
import { setNestedValue } from "../config/loader.js";
import { makeMockLogger } from "./helpers/mock-logger.js";

mock.module("../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

let savedRaw: Record<string, unknown> | null = null;
let rawConfig: Record<string, unknown>;
// Counters so tests can assert whether `commitConfigWrite` ran its post-write
// side effects: rejected writes must leave both at 0, allowed writes bump
// each exactly once.
let invalidateConfigCacheCalls = 0;
let initializeProvidersCalls = 0;

function makeDefaultRawConfig(): Record<string, unknown> {
  return {
    llm: {
      profiles: {
        "quality-optimized": {
          provider: "anthropic",
          model: "claude-sonnet",
          source: "managed",
        },
        balanced: {
          provider: "anthropic",
          model: "claude-sonnet",
          source: "managed",
        },
        "cost-optimized": {
          provider: "anthropic",
          model: "claude-haiku",
          source: "managed",
        },
        "my-custom": { provider: "openai", model: "gpt-4o", source: "user" },
      },
    },
  };
}

function deepMergeForTest(
  target: Record<string, unknown>,
  overrides: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(overrides)) {
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      target[key] !== null &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      deepMergeForTest(
        target[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
      continue;
    }
    target[key] = value;
  }
}

mock.module("../config/loader.js", () => ({
  loadRawConfig: () => structuredClone(rawConfig),
  saveRawConfig: (raw: Record<string, unknown>) => {
    savedRaw = raw;
  },
  deepMergeOverwrite: (
    target: Record<string, unknown>,
    overrides: Record<string, unknown>,
  ) => {
    deepMergeForTest(target, overrides);
  },
  getConfig: () => rawConfig,
  getDeploymentContextDefaults: () => ({}),
  invalidateConfigCache: () => {
    invalidateConfigCacheCalls += 1;
  },
  setNestedValue,
  withSuppressedConfigDiskWrites: async (fn: () => unknown) => fn(),
  withSuppressedConfigDiskWritesSync: (fn: () => unknown) => fn(),
}));

mock.module("../providers/registry.js", () => ({
  initializeProviders: async () => {
    initializeProvidersCalls += 1;
  },
}));

mock.module("../persistence/embeddings/embedding-backend.js", () => ({
  clearEmbeddingBackendCache: () => {},
}));

// The replace-profile handler auto-derives `provider_connection` from the
// first active connection matching the requested provider when the body
// omits it. That path queries the `provider_connections` table, which the
// test doesn't migrate — stub it out so the guard logic stays the focus.
mock.module("../providers/inference/connections.js", () => ({
  listConnections: () => [],
  createConnection: () => ({ ok: false, error: { code: "already_exists" } }),
  PROVIDERS_REQUIRING_BASE_URL_AND_MODELS: new Set(["openai-compatible"]),
}));

import { ROUTES } from "../runtime/routes/conversation-query-routes.js";
import { BadRequestError } from "../runtime/routes/errors.js";

const replaceRoute = ROUTES.find(
  (r) => r.operationId === "config_llm_profiles_replace",
)!;

const patchRoute = ROUTES.find((r) => r.operationId === "config_patch")!;

const setRoute = ROUTES.find((r) => r.operationId === "config_set")!;

beforeEach(() => {
  rawConfig = makeDefaultRawConfig();
  savedRaw = null;
  invalidateConfigCacheCalls = 0;
  initializeProvidersCalls = 0;
});

function expectNothingCommitted(): void {
  expect(savedRaw).toBeNull();
  expect(initializeProvidersCalls).toBe(0);
  expect(invalidateConfigCacheCalls).toBe(0);
}

function expectOneCommitCycle(): void {
  expect(savedRaw).not.toBeNull();
  expect(initializeProvidersCalls).toBe(1);
  expect(invalidateConfigCacheCalls).toBe(1);
}

function savedProfile(name: string): Record<string, unknown> {
  return (savedRaw as Record<string, any>).llm.profiles[name] as Record<
    string,
    unknown
  >;
}

// ---------------------------------------------------------------------------
// PUT /v1/config/llm/profiles/:name — replace inference profile
// ---------------------------------------------------------------------------

describe("PUT /v1/config/llm/profiles/:name — managed profile guard", () => {
  test("rejects edits to quality-optimized that touch non-label/status fields", async () => {
    await expect(
      replaceRoute.handler({
        pathParams: { name: "quality-optimized" },
        body: { provider: "openai", model: "gpt-4o" },
      }),
    ).rejects.toThrow(
      'Cannot edit managed profile "quality-optimized" fields [provider, model]. ' +
        "Default profiles are read-only (a disabled default can be re-enabled); " +
        "duplicate to a custom profile to customize.",
    );
  });

  test("rejects edits to balanced", async () => {
    await expect(
      replaceRoute.handler({
        pathParams: { name: "balanced" },
        body: { provider: "openai", model: "gpt-4o" },
      }),
    ).rejects.toThrow(BadRequestError);
  });

  test("rejects edits to cost-optimized", async () => {
    await expect(
      replaceRoute.handler({
        pathParams: { name: "cost-optimized" },
        body: { provider: "openai", model: "gpt-4o" },
      }),
    ).rejects.toThrow(BadRequestError);
  });

  test("allows edits to custom-balanced (user-owned)", async () => {
    savedRaw = null;
    const result = await replaceRoute.handler({
      pathParams: { name: "custom-balanced" },
      body: { provider: "openai", model: "gpt-4o" },
    });
    expect(result).toEqual({ ok: true });
    expect(savedRaw).not.toBeNull();
  });

  test("allows edits to a user-defined profile", async () => {
    savedRaw = null;
    const result = await replaceRoute.handler({
      pathParams: { name: "my-custom" },
      body: { provider: "openai", model: "gpt-4o" },
    });
    expect(result).toEqual({ ok: true });
    expect(savedRaw).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Null-as-clear sentinel: clients send `{ label: null }` or
  // `{ status: null }` to clear a managed profile's overrides back to the
  // seed defaults. The Zod `ProfileEntry` schema accepts null for both
  // fields. On non-invariant managed profiles (os-beta) the clear round-trips
  // to disk; on the invariant default profiles only the status clear is
  // allowed (re-enable) — every other field is frozen at commit time.
  // -------------------------------------------------------------------------

  test("PUT { label: null } on a default profile is rejected (label is frozen)", async () => {
    savedRaw = null;
    rawConfig = {
      llm: {
        profiles: {
          balanced: {
            provider: "anthropic",
            model: "claude-sonnet",
            label: "My Custom Name",
            source: "managed",
          },
        },
      },
    };
    await expect(
      replaceRoute.handler({
        pathParams: { name: "balanced" },
        body: { label: null },
      }),
    ).rejects.toThrow('Cannot edit default profile "balanced" fields [label]');
    expectNothingCommitted();
  });

  test("PUT { status: null } on managed profile clears status (back to active-by-absence)", async () => {
    savedRaw = null;
    rawConfig = {
      llm: {
        profiles: {
          "quality-optimized": {
            provider: "anthropic",
            model: "claude-opus",
            status: "disabled",
            source: "managed",
          },
        },
      },
    };
    const result = await replaceRoute.handler({
      pathParams: { name: "quality-optimized" },
      body: { status: null },
    });
    expect(result).toEqual({ ok: true });
    const profile = (savedRaw as unknown as Record<string, any>)?.llm
      ?.profiles?.["quality-optimized"] as Record<string, unknown>;
    expect("status" in profile).toBe(false);
    expect(profile.provider).toBe("anthropic");
    expect(profile.model).toBe("claude-opus");
  });

  test("PUT { label: null, status: null } on managed os-beta clears both in a single request", async () => {
    savedRaw = null;
    rawConfig = {
      llm: {
        profiles: {
          "os-beta": {
            provider: "together",
            model: "zai-org/GLM-5.2",
            label: "OS Beta (Custom)",
            status: "disabled",
            source: "managed",
          },
        },
      },
    };
    const result = await replaceRoute.handler({
      pathParams: { name: "os-beta" },
      body: { label: null, status: null },
    });
    expect(result).toEqual({ ok: true });
    const profile = savedProfile("os-beta");
    expect("label" in profile).toBe(false);
    expect(profile.status).toBeUndefined();
    expect(profile.provider).toBe("together");
    expect(profile.model).toBe("zai-org/GLM-5.2");
  });

  test("PUT { label: null, status: 'disabled' } on managed os-beta mixes clear + set in one call", async () => {
    savedRaw = null;
    rawConfig = {
      llm: {
        profiles: {
          "os-beta": {
            provider: "together",
            model: "zai-org/GLM-5.2",
            label: "Custom Label",
            source: "managed",
          },
        },
      },
    };
    const result = await replaceRoute.handler({
      pathParams: { name: "os-beta" },
      body: { label: null, status: "disabled" },
    });
    expect(result).toEqual({ ok: true });
    const profile = savedProfile("os-beta");
    expect("label" in profile).toBe(false);
    expect(profile.status).toBe("disabled");
  });

  test("PUT { topP } on managed os-beta is accepted and persisted", async () => {
    savedRaw = null;
    rawConfig = {
      llm: {
        profiles: {
          "os-beta": {
            provider: "together",
            model: "zai-org/GLM-5.2",
            source: "managed",
          },
        },
      },
    };
    const result = await replaceRoute.handler({
      pathParams: { name: "os-beta" },
      body: { topP: 0.9 },
    });
    expect(result).toEqual({ ok: true });
    const profile = savedProfile("os-beta");
    // topP override persisted; seed fields preserved.
    expect(profile.topP).toBe(0.9);
    expect(profile.provider).toBe("together");
    expect(profile.model).toBe("zai-org/GLM-5.2");
    expect(profile.source).toBe("managed");
  });

  test("PUT { topP: null } on managed os-beta clears the override on disk", async () => {
    savedRaw = null;
    rawConfig = {
      llm: {
        profiles: {
          "os-beta": {
            provider: "together",
            model: "zai-org/GLM-5.2",
            topP: 0.7,
            source: "managed",
          },
        },
      },
    };
    const result = await replaceRoute.handler({
      pathParams: { name: "os-beta" },
      body: { topP: null },
    });
    expect(result).toEqual({ ok: true });
    const profile = savedProfile("os-beta");
    expect("topP" in profile).toBe(false);
    expect(profile.provider).toBe("together");
    expect(profile.model).toBe("zai-org/GLM-5.2");
  });

  test("allows edits to a user-owned profile sharing a managed name (os-beta)", async () => {
    savedRaw = null;
    rawConfig = {
      llm: {
        profiles: {
          "os-beta": {
            provider: "anthropic",
            model: "claude-sonnet",
            source: "user",
          },
        },
      },
    };
    const result = await replaceRoute.handler({
      pathParams: { name: "os-beta" },
      body: { provider: "openai", model: "gpt-4o" },
    });
    expect(result).toEqual({ ok: true });
    const profile = (savedRaw as unknown as Record<string, any>)?.llm
      ?.profiles?.["os-beta"] as Record<string, unknown>;
    expect(profile.provider).toBe("openai");
    expect(profile.model).toBe("gpt-4o");
  });

  test("rejects edits to a managed os-beta profile", async () => {
    rawConfig = {
      llm: {
        profiles: {
          "os-beta": {
            provider: "fireworks",
            model: "accounts/fireworks/models/glm-5p2",
            source: "managed",
          },
        },
      },
    };
    await expect(
      replaceRoute.handler({
        pathParams: { name: "os-beta" },
        body: { provider: "openai", model: "gpt-4o" },
      }),
    ).rejects.toThrow(BadRequestError);
  });

  test("rejects PUT to os-beta when no os-beta profile exists, writing no stub", async () => {
    savedRaw = null;
    rawConfig = { llm: { profiles: {} } };
    await expect(
      replaceRoute.handler({
        pathParams: { name: "os-beta" },
        body: { label: "My OS Beta" },
      }),
    ).rejects.toThrow("not currently available");
    expect(savedRaw).toBeNull();
    expect(
      (rawConfig as Record<string, any>)?.llm?.profiles?.["os-beta"],
    ).toBeUndefined();
  });

  test("PUT { label: '' } on managed profile still rejected by `.min(1)`", async () => {
    // `.nullable()` only widens the type to accept null — empty strings
    // still fail the min-length check, which is correct: an empty string
    // would persist as a literal "" override, not the clear-to-seed
    // intent. Clients must send `null` to clear.
    await expect(
      replaceRoute.handler({
        pathParams: { name: "balanced" },
        body: { label: "" },
      }),
    ).rejects.toThrow(BadRequestError);
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/config — managed profile deletion guard
// ---------------------------------------------------------------------------

describe("PATCH /v1/config — managed profile deletion guard", () => {
  test("rejects deletion of quality-optimized via null with descriptive message", async () => {
    await expect(
      patchRoute.handler({
        body: { llm: { profiles: { "quality-optimized": null } } },
      }),
    ).rejects.toThrow('Cannot delete managed profile "quality-optimized".');
  });

  test("rejects deletion of balanced via null", async () => {
    await expect(
      patchRoute.handler({
        body: { llm: { profiles: { balanced: null } } },
      }),
    ).rejects.toThrow(BadRequestError);
  });

  test("rejects deletion of cost-optimized via null", async () => {
    await expect(
      patchRoute.handler({
        body: { llm: { profiles: { "cost-optimized": null } } },
      }),
    ).rejects.toThrow(BadRequestError);
  });

  test("allows deletion of custom-balanced via null (user-owned)", async () => {
    savedRaw = null;
    const result = await patchRoute.handler({
      body: { llm: { profiles: { "custom-balanced": null } } },
    });
    expect(result).toHaveProperty("llm");
  });

  test("allows deletion of a user-defined profile via null", async () => {
    savedRaw = null;
    const result = await patchRoute.handler({
      body: { llm: { profiles: { "my-custom": null } } },
    });
    expect(result).toHaveProperty("llm");
  });

  test("allows non-profile config patches", async () => {
    const result = await patchRoute.handler({
      body: { someOtherKey: "value" },
    });
    expect(result).toHaveProperty("llm");
  });

  test("clears stale Velay ownership when manually patching public base URL", async () => {
    rawConfig = {
      ingress: {
        publicBaseUrl: "https://stale-velay.example.test",
        publicBaseUrlManagedBy: "velay",
      },
    };

    const result = await patchRoute.handler({
      body: {
        ingress: { publicBaseUrl: "https://manual.example.test" },
      },
    });

    expect(result).toHaveProperty("ingress");
    expect(savedRaw).toEqual({
      ingress: {
        publicBaseUrl: "https://manual.example.test",
        publicBaseUrlManagedBy: "velay",
      },
    });
  });

  test("allows patches that modify a managed profile (non-null)", async () => {
    savedRaw = null;
    const result = await patchRoute.handler({
      body: {
        llm: {
          profiles: { "quality-optimized": { provider: "anthropic" } },
        },
      },
    });
    expect(result).toHaveProperty("llm");
  });

  test("allows deletion of a user-owned profile sharing a managed name (os-beta)", async () => {
    savedRaw = null;
    rawConfig = {
      llm: {
        profiles: {
          "os-beta": {
            provider: "anthropic",
            model: "claude-sonnet",
            source: "user",
          },
        },
      },
    };
    const result = await patchRoute.handler({
      body: { llm: { profiles: { "os-beta": null } } },
    });
    expect(result).toHaveProperty("llm");
  });

  test("rejects deletion of a managed os-beta profile", async () => {
    rawConfig = {
      llm: {
        profiles: {
          "os-beta": {
            provider: "fireworks",
            model: "accounts/fireworks/models/glm-5p2",
            source: "managed",
          },
        },
      },
    };
    await expect(
      patchRoute.handler({
        body: { llm: { profiles: { "os-beta": null } } },
      }),
    ).rejects.toThrow('Cannot delete managed profile "os-beta".');
  });

  test("rejects nulling the entire profiles map", async () => {
    await expect(
      patchRoute.handler({
        body: { llm: { profiles: null } },
      }),
    ).rejects.toThrow("Cannot null llm.profiles");
  });
});

// ---------------------------------------------------------------------------
// commitConfigWrite — default-profile invariant guard
//
// The three default profiles (balanced, quality-optimized, cost-optimized)
// are read-only to every config-write route; the only writable transition is
// re-enabling a disabled default. Enforced by
// `assertInvariantProfilesPreserved` at the commitConfigWrite choke point,
// so PATCH, SET, and PUT are all covered by the same checks.
// ---------------------------------------------------------------------------

describe("default-profile invariant guard — rejected writes", () => {
  test("PATCH disabling balanced is rejected (active → disabled)", async () => {
    await expect(
      patchRoute.handler({
        body: { llm: { profiles: { balanced: { status: "disabled" } } } },
      }),
    ).rejects.toThrow('Cannot disable default profile "balanced".');
    expectNothingCommitted();
  });

  test("PATCH setting a label on balanced is rejected", async () => {
    await expect(
      patchRoute.handler({
        body: { llm: { profiles: { balanced: { label: "X" } } } },
      }),
    ).rejects.toThrow(
      'Cannot edit default profile "balanced" fields [label]. ' +
        "Default profiles are read-only; duplicate to a custom profile to customize.",
    );
    expectNothingCommitted();
  });

  test("PATCH { label: null } on balanced is rejected when a label exists", async () => {
    (rawConfig as Record<string, any>).llm.profiles.balanced.label = "Balanced";
    await expect(
      patchRoute.handler({
        body: { llm: { profiles: { balanced: { label: null } } } },
      }),
    ).rejects.toThrow('Cannot edit default profile "balanced" fields [label]');
    expectNothingCommitted();
  });

  test("PATCH { topP: 0.8 } on balanced is rejected", async () => {
    await expect(
      patchRoute.handler({
        body: { llm: { profiles: { balanced: { topP: 0.8 } } } },
      }),
    ).rejects.toThrow('Cannot edit default profile "balanced" fields [topP]');
    expectNothingCommitted();
  });

  test("PATCH { topP: null } on balanced is rejected when an on-disk override exists", async () => {
    (rawConfig as Record<string, any>).llm.profiles.balanced.topP = 0.7;
    await expect(
      patchRoute.handler({
        body: { llm: { profiles: { balanced: { topP: null } } } },
      }),
    ).rejects.toThrow('Cannot edit default profile "balanced" fields [topP]');
    expectNothingCommitted();
  });

  test("PATCH deleting a user-sourced balanced entry is rejected by the invariant guard", async () => {
    // A `source: "user"` entry passes the legacy managed-deletion guard, so
    // this exercises the invariant guard's missing-entry check directly.
    (rawConfig as Record<string, any>).llm.profiles.balanced.source = "user";
    await expect(
      patchRoute.handler({
        body: { llm: { profiles: { balanced: null } } },
      }),
    ).rejects.toThrow(
      'Cannot delete or replace default profile "balanced". Default profiles are read-only.',
    );
    expectNothingCommitted();
  });

  test("PATCH overwriting balanced with a string is rejected", async () => {
    await expect(
      patchRoute.handler({
        body: { llm: { profiles: { balanced: "junk" } } },
      }),
    ).rejects.toThrow('Cannot delete or replace default profile "balanced".');
    expectNothingCommitted();
  });

  test("PATCH overwriting balanced with an array is rejected", async () => {
    await expect(
      patchRoute.handler({
        body: { llm: { profiles: { balanced: ["disabled"] } } },
      }),
    ).rejects.toThrow('Cannot delete or replace default profile "balanced".');
    expectNothingCommitted();
  });

  // PUT and SET flow through the same commitConfigWrite guard as PATCH, so
  // the per-field matrix above isn't repeated per route — one rejection per
  // route proves the wiring.
  test("PUT { status: 'disabled' } on balanced is rejected", async () => {
    await expect(
      replaceRoute.handler({
        pathParams: { name: "balanced" },
        body: { status: "disabled" },
      }),
    ).rejects.toThrow('Cannot disable default profile "balanced".');
    expectNothingCommitted();
  });

  test("SET llm.profiles.balanced.status = 'disabled' is rejected", async () => {
    await expect(
      setRoute.handler({
        body: { path: "llm.profiles.balanced.status", value: "disabled" },
      }),
    ).rejects.toThrow('Cannot disable default profile "balanced".');
    expectNothingCommitted();
  });

  test("SET llm = {} is rejected (would drop all defaults)", async () => {
    await expect(
      setRoute.handler({ body: { path: "llm", value: {} } }),
    ).rejects.toThrow(/Cannot delete or replace default profile/);
    expectNothingCommitted();
  });

  test("PATCH { status: 'weird' } on balanced is rejected (junk status)", async () => {
    await expect(
      patchRoute.handler({
        body: { llm: { profiles: { balanced: { status: "weird" } } } },
      }),
    ).rejects.toThrow(
      'Cannot set status "weird" on default profile "balanced". ' +
        'Only re-enabling (status "active") is allowed.',
    );
    expectNothingCommitted();
  });

  test("SET llm.profiles.balanced.status = 123 is rejected (junk status)", async () => {
    await expect(
      setRoute.handler({
        body: { path: "llm.profiles.balanced.status", value: 123 },
      }),
    ).rejects.toThrow('Cannot set status 123 on default profile "balanced"');
    expectNothingCommitted();
  });
});

describe("default-profile invariant guard — allowed writes", () => {
  test("PATCH re-enables a disabled default profile (BYOK re-enable)", async () => {
    (rawConfig as Record<string, any>).llm.profiles.balanced.status =
      "disabled";
    const result = await patchRoute.handler({
      body: { llm: { profiles: { balanced: { status: "active" } } } },
    });
    expect(result).toHaveProperty("llm");
    expectOneCommitCycle();
    expect(savedProfile("balanced").status).toBe("active");
  });

  test("PATCH { status: null } clears a disabled default back to active-by-absence", async () => {
    (rawConfig as Record<string, any>).llm.profiles.balanced.status =
      "disabled";
    const result = await patchRoute.handler({
      body: { llm: { profiles: { balanced: { status: null } } } },
    });
    expect(result).toHaveProperty("llm");
    expectOneCommitCycle();
    expect(savedProfile("balanced").status ?? null).toBeNull();
  });

  test("PUT { status: 'active' } re-enables a disabled default profile", async () => {
    (rawConfig as Record<string, any>).llm.profiles.balanced.status =
      "disabled";
    const result = await replaceRoute.handler({
      pathParams: { name: "balanced" },
      body: { status: "active" },
    });
    expect(result).toEqual({ ok: true });
    expectOneCommitCycle();
    expect(savedProfile("balanced").status).toBe("active");
  });

  test("SET llm.profiles.balanced.status = 'active' re-enables a disabled default profile", async () => {
    (rawConfig as Record<string, any>).llm.profiles.balanced.status =
      "disabled";
    const result = await setRoute.handler({
      body: { path: "llm.profiles.balanced.status", value: "active" },
    });
    expect(result).toEqual({ ok: true });
    expectOneCommitCycle();
    expect(savedProfile("balanced").status).toBe("active");
  });

  test("SET llm passes when the value carries the invariant profiles unchanged (incl. frozen topP override)", async () => {
    (rawConfig as Record<string, any>).llm.profiles.balanced.topP = 0.7;
    const nextLlm = structuredClone(
      (rawConfig as Record<string, any>).llm,
    ) as Record<string, unknown>;
    nextLlm.activeProfile = "my-custom";
    const result = await setRoute.handler({
      body: { path: "llm", value: nextLlm },
    });
    expect(result).toEqual({ ok: true });
    expectOneCommitCycle();
    // The pre-existing topP override survives untouched.
    expect(savedProfile("balanced").topP).toBe(0.7);
    expect((savedRaw as Record<string, any>).llm.activeProfile).toBe(
      "my-custom",
    );
  });

  test("PUT label/status/topP edits on managed os-beta remain allowed (non-invariant)", async () => {
    (rawConfig as Record<string, any>).llm.profiles["os-beta"] = {
      provider: "together",
      model: "zai-org/GLM-5.2",
      source: "managed",
    };
    const result = await replaceRoute.handler({
      pathParams: { name: "os-beta" },
      body: { label: "My OS Beta", status: "disabled", topP: 0.5 },
    });
    expect(result).toEqual({ ok: true });
    expectOneCommitCycle();
    const profile = savedProfile("os-beta");
    expect(profile.label).toBe("My OS Beta");
    expect(profile.status).toBe("disabled");
    expect(profile.topP).toBe(0.5);
  });

  test("PUT full edits on a custom profile remain allowed", async () => {
    const result = await replaceRoute.handler({
      pathParams: { name: "my-custom" },
      body: { provider: "openai", model: "gpt-4o", maxTokens: 4096 },
    });
    expect(result).toEqual({ ok: true });
    expectOneCommitCycle();
    const profile = savedProfile("my-custom");
    expect(profile.provider).toBe("openai");
    expect(profile.model).toBe("gpt-4o");
    expect(profile.maxTokens).toBe(4096);
  });

  test("PATCH non-profile llm writes are unaffected", async () => {
    const result = await patchRoute.handler({
      body: { llm: { activeProfile: "custom" } },
    });
    expect(result).toHaveProperty("llm");
    expectOneCommitCycle();
    expect((savedRaw as Record<string, any>).llm.activeProfile).toBe("custom");
    // The invariant profiles are untouched by an unrelated llm write.
    expect(savedProfile("balanced")).toEqual(
      (makeDefaultRawConfig() as Record<string, any>).llm.profiles.balanced,
    );
  });
});

// ---------------------------------------------------------------------------
// Wire-only profile keys (`invariant`, `supportsVision`) are stamped onto
// config GET/PATCH responses but never persisted. Writes carrying them —
// e.g. a `config get` → `config set` round-trip — must succeed with the
// wire keys stripped, not 400 on phantom fields.
// ---------------------------------------------------------------------------

describe("wire-only profile keys are stripped from writes", () => {
  test("PATCH re-enable carrying wire keys succeeds and persists neither key", async () => {
    (rawConfig as Record<string, any>).llm.profiles.balanced.status =
      "disabled";
    const result = await patchRoute.handler({
      body: {
        llm: {
          profiles: {
            balanced: {
              status: "active",
              invariant: true,
              supportsVision: true,
            },
          },
        },
      },
    });
    expect(result).toHaveProperty("llm");
    expectOneCommitCycle();
    const profile = savedProfile("balanced");
    expect(profile.status).toBe("active");
    expect("invariant" in profile).toBe(false);
    expect("supportsVision" in profile).toBe(false);
  });

  test("SET llm.profiles.balanced with a wire-shaped entry (GET round-trip) succeeds", async () => {
    const entry = structuredClone(
      (rawConfig as Record<string, any>).llm.profiles.balanced,
    ) as Record<string, unknown>;
    entry.invariant = true;
    entry.supportsVision = true;
    const result = await setRoute.handler({
      body: { path: "llm.profiles.balanced", value: entry },
    });
    expect(result).toEqual({ ok: true });
    expectOneCommitCycle();
    const profile = savedProfile("balanced");
    expect("invariant" in profile).toBe(false);
    expect("supportsVision" in profile).toBe(false);
    expect(profile.provider).toBe("anthropic");
    expect(profile.model).toBe("claude-sonnet");
  });

  test("SET of a wire-only leaf path is dropped without writing", async () => {
    const result = await setRoute.handler({
      body: { path: "llm.profiles.balanced.supportsVision", value: true },
    });
    expect(result).toEqual({ ok: true });
    expectNothingCommitted();
  });

  test("PATCH with supportsVision on a custom profile does not persist it", async () => {
    const result = await patchRoute.handler({
      body: {
        llm: {
          profiles: { "my-custom": { supportsVision: false, maxTokens: 2048 } },
        },
      },
    });
    expect(result).toHaveProperty("llm");
    expectOneCommitCycle();
    const profile = savedProfile("my-custom");
    expect("supportsVision" in profile).toBe(false);
    expect(profile.maxTokens).toBe(2048);
  });
});
