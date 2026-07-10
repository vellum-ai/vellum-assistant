/**
 * Tests the two layers protecting managed inference profiles:
 *
 * - Route-level managed guards: managed profiles can't be deleted via PATCH
 *   and the PUT profile route accepts only a pure status re-enable body for
 *   them.
 * - The commitConfigWrite invariant guard: every managed profile name
 *   ("quality-optimized", "balanced", "cost-optimized", "os-beta") is fully
 *   read-only across PATCH/SET/PUT while its on-disk entry is
 *   managed-source — the only writable transition is re-enabling a disabled
 *   profile. A user-owned (`source: "user"`) entry sharing a managed name is
 *   not locked.
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
  getConnection: () => null,
  VELLUM_MANAGED_CONNECTION_NAME: "vellum",
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
  test("rejects provider/model edits to quality-optimized", async () => {
    await expect(
      replaceRoute.handler({
        pathParams: { name: "quality-optimized" },
        body: { provider: "openai", model: "gpt-4o" },
      }),
    ).rejects.toThrow(
      'Cannot edit managed profile "quality-optimized" fields [provider, model]. ' +
        "Managed profiles are read-only (a disabled profile can be re-enabled); " +
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
  // fields. Every managed name is invariant, so on managed-source entries
  // only the status clear is allowed (re-enable) — every other field is
  // frozen at commit time.
  // -------------------------------------------------------------------------

  test("PUT { label: null } on a managed profile is rejected (label is frozen)", async () => {
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
    ).rejects.toThrow('Cannot edit managed profile "balanced" fields [label]');
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

  test("PUT { label: null, status: null } on managed os-beta is rejected (label is frozen)", async () => {
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
    // The status clear alone is the re-enable direction and would pass, but
    // the label clear touches a frozen field so the whole write is rejected.
    await expect(
      replaceRoute.handler({
        pathParams: { name: "os-beta" },
        body: { label: null, status: null },
      }),
    ).rejects.toThrow('Cannot edit managed profile "os-beta" fields [label]');
    expectNothingCommitted();
  });

  test("PUT { status: 'disabled' } on managed os-beta is rejected (read-only)", async () => {
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
    await expect(
      replaceRoute.handler({
        pathParams: { name: "os-beta" },
        body: { status: "disabled" },
      }),
    ).rejects.toThrow(
      'Cannot edit managed profile "os-beta". Managed profiles are read-only',
    );
    expectNothingCommitted();
  });

  test("PUT { topP } on managed os-beta is rejected (topP is frozen)", async () => {
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
    await expect(
      replaceRoute.handler({
        pathParams: { name: "os-beta" },
        body: { topP: 0.9 },
      }),
    ).rejects.toThrow('Cannot edit managed profile "os-beta" fields [topP]');
    expectNothingCommitted();
  });

  test("PUT { topP: null } on managed os-beta is rejected (frozen even when clearing)", async () => {
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
    await expect(
      replaceRoute.handler({
        pathParams: { name: "os-beta" },
        body: { topP: null },
      }),
    ).rejects.toThrow('Cannot edit managed profile "os-beta" fields [topP]');
    expectNothingCommitted();
  });

  test("PUT { status: 'active' } re-enables a disabled managed os-beta profile", async () => {
    savedRaw = null;
    rawConfig = {
      llm: {
        profiles: {
          "os-beta": {
            provider: "together",
            model: "zai-org/GLM-5.2",
            status: "disabled",
            source: "managed",
          },
        },
      },
    };
    const result = await replaceRoute.handler({
      pathParams: { name: "os-beta" },
      body: { status: "active" },
    });
    expect(result).toEqual({ ok: true });
    expectOneCommitCycle();
    const profile = savedProfile("os-beta");
    expect(profile.status).toBe("active");
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
// commitConfigWrite — managed-profile invariant guard
//
// Every managed profile name (balanced, quality-optimized, cost-optimized,
// os-beta) is read-only to every config-write route while its on-disk entry
// is managed-source; the only writable transition is re-enabling a disabled
// profile. A user-owned entry sharing a managed name is not locked. Enforced
// by `assertInvariantProfilesPreserved` at the commitConfigWrite choke
// point, so PATCH, SET, and PUT are all covered by the same checks.
// ---------------------------------------------------------------------------

describe("managed-profile invariant guard — rejected writes", () => {
  test("PATCH disabling balanced is rejected (active → disabled)", async () => {
    await expect(
      patchRoute.handler({
        body: { llm: { profiles: { balanced: { status: "disabled" } } } },
      }),
    ).rejects.toThrow('Cannot disable managed profile "balanced".');
    expectNothingCommitted();
  });

  test("PATCH setting a label on balanced is rejected", async () => {
    await expect(
      patchRoute.handler({
        body: { llm: { profiles: { balanced: { label: "X" } } } },
      }),
    ).rejects.toThrow(
      'Cannot edit managed profile "balanced" fields [label]. ' +
        "Managed profiles are read-only; duplicate to a custom profile to customize.",
    );
    expectNothingCommitted();
  });

  test("PATCH { label: null } on balanced is rejected when a label exists", async () => {
    (rawConfig as Record<string, any>).llm.profiles.balanced.label = "Balanced";
    await expect(
      patchRoute.handler({
        body: { llm: { profiles: { balanced: { label: null } } } },
      }),
    ).rejects.toThrow('Cannot edit managed profile "balanced" fields [label]');
    expectNothingCommitted();
  });

  test("PATCH { topP: 0.8 } on balanced is rejected", async () => {
    await expect(
      patchRoute.handler({
        body: { llm: { profiles: { balanced: { topP: 0.8 } } } },
      }),
    ).rejects.toThrow('Cannot edit managed profile "balanced" fields [topP]');
    expectNothingCommitted();
  });

  test("PATCH { topP: null } on balanced is rejected when an on-disk override exists", async () => {
    (rawConfig as Record<string, any>).llm.profiles.balanced.topP = 0.7;
    await expect(
      patchRoute.handler({
        body: { llm: { profiles: { balanced: { topP: null } } } },
      }),
    ).rejects.toThrow('Cannot edit managed profile "balanced" fields [topP]');
    expectNothingCommitted();
  });

  test("PATCH disabling a managed-source os-beta is rejected (active → disabled)", async () => {
    (rawConfig as Record<string, any>).llm.profiles["os-beta"] = {
      provider: "together",
      model: "zai-org/GLM-5.2",
      source: "managed",
    };
    await expect(
      patchRoute.handler({
        body: { llm: { profiles: { "os-beta": { status: "disabled" } } } },
      }),
    ).rejects.toThrow('Cannot disable managed profile "os-beta".');
    expectNothingCommitted();
  });

  test("SET llm.profiles.os-beta.label is rejected on a managed-source entry", async () => {
    (rawConfig as Record<string, any>).llm.profiles["os-beta"] = {
      provider: "together",
      model: "zai-org/GLM-5.2",
      source: "managed",
    };
    await expect(
      setRoute.handler({
        body: { path: "llm.profiles.os-beta.label", value: "My OS Beta" },
      }),
    ).rejects.toThrow('Cannot edit managed profile "os-beta" fields [label]');
    expectNothingCommitted();
  });

  test("PATCH overwriting balanced with a string is rejected", async () => {
    await expect(
      patchRoute.handler({
        body: { llm: { profiles: { balanced: "junk" } } },
      }),
    ).rejects.toThrow('Cannot delete or replace managed profile "balanced".');
    expectNothingCommitted();
  });

  test("PATCH overwriting balanced with an array is rejected", async () => {
    await expect(
      patchRoute.handler({
        body: { llm: { profiles: { balanced: ["disabled"] } } },
      }),
    ).rejects.toThrow('Cannot delete or replace managed profile "balanced".');
    expectNothingCommitted();
  });

  // SET flows through the same commitConfigWrite guard as PATCH, so the
  // per-field matrix above isn't repeated per route — one rejection per
  // route proves the wiring. PUT rejects non-re-enable managed bodies at its
  // own gate, before the commit guard.
  test("PUT { status: 'disabled' } on balanced is rejected", async () => {
    await expect(
      replaceRoute.handler({
        pathParams: { name: "balanced" },
        body: { status: "disabled" },
      }),
    ).rejects.toThrow(
      'Cannot edit managed profile "balanced". Managed profiles are read-only',
    );
    expectNothingCommitted();
  });

  test("SET llm.profiles.balanced.status = 'disabled' is rejected", async () => {
    await expect(
      setRoute.handler({
        body: { path: "llm.profiles.balanced.status", value: "disabled" },
      }),
    ).rejects.toThrow('Cannot disable managed profile "balanced".');
    expectNothingCommitted();
  });

  test("SET llm = {} is rejected (would drop all defaults)", async () => {
    await expect(
      setRoute.handler({ body: { path: "llm", value: {} } }),
    ).rejects.toThrow(/Cannot delete or replace managed profile/);
    expectNothingCommitted();
  });

  test("PATCH { status: 'weird' } on balanced is rejected (junk status)", async () => {
    await expect(
      patchRoute.handler({
        body: { llm: { profiles: { balanced: { status: "weird" } } } },
      }),
    ).rejects.toThrow(
      'Cannot set status "weird" on managed profile "balanced". ' +
        'Only re-enabling (status "active") is allowed.',
    );
    expectNothingCommitted();
  });

  test("SET llm.profiles.balanced.status = 123 is rejected (junk status)", async () => {
    await expect(
      setRoute.handler({
        body: { path: "llm.profiles.balanced.status", value: 123 },
      }),
    ).rejects.toThrow('Cannot set status 123 on managed profile "balanced"');
    expectNothingCommitted();
  });
});

describe("default-profile invariant guard — allowed writes", () => {
  test("PATCH re-enables a disabled managed profile (BYOK re-enable)", async () => {
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

  test("PUT { status: 'active' } re-enables a disabled managed profile", async () => {
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

  test("SET llm.profiles.balanced.status = 'active' re-enables a disabled managed profile", async () => {
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

  test("PATCH deleting a user-sourced balanced entry is allowed (invariance is source-gated)", async () => {
    // A `source: "user"` entry passes the managed-deletion guard AND the
    // invariant guard — both key on the on-disk entry's managed source, so
    // a user-owned profile sharing a managed name stays deletable.
    (rawConfig as Record<string, any>).llm.profiles.balanced.source = "user";
    const result = await patchRoute.handler({
      body: { llm: { profiles: { balanced: null } } },
    });
    expect(result).toHaveProperty("llm");
    expectOneCommitCycle();
  });

  test("PUT full edits on a user-sourced os-beta entry are allowed (invariance is source-gated)", async () => {
    (rawConfig as Record<string, any>).llm.profiles["os-beta"] = {
      provider: "anthropic",
      model: "claude-sonnet",
      source: "user",
    };
    const result = await replaceRoute.handler({
      pathParams: { name: "os-beta" },
      body: { provider: "openai", model: "gpt-4o", topP: 0.5 },
    });
    expect(result).toEqual({ ok: true });
    expectOneCommitCycle();
    const profile = savedProfile("os-beta");
    expect(profile.provider).toBe("openai");
    expect(profile.model).toBe("gpt-4o");
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

  // -------------------------------------------------------------------------
  // Stale wire-only keys on disk: configs written before the write-side strip
  // existed can carry `supportsVision` under a managed profile. The invariant
  // guard ignores wire-only keys on both sides, so a GET → write round-trip
  // (whose incoming copy is stripped) is not rejected for "removing" the
  // stale key — and a full-entry SET drops it from disk.
  // -------------------------------------------------------------------------

  test("SET round-trip re-enabling a managed profile with stale on-disk supportsVision succeeds and drops the stale key", async () => {
    const balanced = (rawConfig as Record<string, any>).llm.profiles.balanced;
    balanced.supportsVision = true; // stale pre-strip persistence
    balanced.status = "disabled";
    const entry = structuredClone(balanced) as Record<string, unknown>;
    entry.invariant = true; // wire stamp from GET
    entry.status = "active"; // legal re-enable
    const result = await setRoute.handler({
      body: { path: "llm.profiles.balanced", value: entry },
    });
    expect(result).toEqual({ ok: true });
    expectOneCommitCycle();
    const profile = savedProfile("balanced");
    expect(profile.status).toBe("active");
    expect("supportsVision" in profile).toBe(false);
    expect("invariant" in profile).toBe(false);
    expect(profile.provider).toBe("anthropic");
    expect(profile.model).toBe("claude-sonnet");
  });

  test("pure no-op SET round-trip with stale on-disk supportsVision succeeds", async () => {
    const balanced = (rawConfig as Record<string, any>).llm.profiles.balanced;
    balanced.supportsVision = true; // stale pre-strip persistence
    const entry = structuredClone(balanced) as Record<string, unknown>;
    entry.invariant = true; // wire stamp from GET
    const result = await setRoute.handler({
      body: { path: "llm.profiles.balanced", value: entry },
    });
    expect(result).toEqual({ ok: true });
    expectOneCommitCycle();
    const profile = savedProfile("balanced");
    expect("supportsVision" in profile).toBe(false);
    expect("invariant" in profile).toBe(false);
    expect(profile.provider).toBe("anthropic");
    expect(profile.model).toBe("claude-sonnet");
  });

  test("PATCH re-enable carrying wire keys succeeds when the on-disk entry has stale supportsVision", async () => {
    const balanced = (rawConfig as Record<string, any>).llm.profiles.balanced;
    balanced.supportsVision = true; // stale pre-strip persistence
    balanced.status = "disabled";
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
    // The deep merge starts from the on-disk entry, so the stale key survives
    // a PATCH (only a full-entry SET removes it) — but the write gains no
    // `invariant` key and never 400s on the phantom-field diff.
    expect("invariant" in profile).toBe(false);
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

// ---------------------------------------------------------------------------
// Code-owned default profiles: wire round-trip and shadowing guards
// ---------------------------------------------------------------------------

const getRoute = ROUTES.find((r) => r.operationId === "config_get")!;

describe("code-owned default profiles — wire view and write normalization", () => {
  test("GET materializes catalog bodies over thin stubs (wire-only)", async () => {
    rawConfig = {
      llm: {
        profiles: { balanced: { source: "managed", status: "disabled" } },
      },
    };
    const response = (await getRoute.handler({})) as Record<string, any>;
    const wireBalanced = response.llm.profiles.balanced;
    expect(wireBalanced.model).toBe("accounts/fireworks/models/glm-5p2");
    expect(wireBalanced.provider_connection).toBe("vellum");
    expect(wireBalanced.status).toBe("disabled");
    expect(wireBalanced.invariant).toBe(true);
    // Absent defaults are materialized too — the catalog owns their content.
    expect(response.llm.profiles["quality-optimized"].model).toBeDefined();
  });

  test("GET → PATCH round-trip of the wire view is accepted and keeps disk stubs thin", async () => {
    rawConfig = {
      llm: {
        profiles: {
          balanced: { source: "managed", status: "disabled" },
          "my-custom": { provider: "openai", model: "gpt-4o", source: "user" },
        },
      },
    };
    const response = (await getRoute.handler({})) as Record<string, any>;
    const result = await patchRoute.handler({
      body: { llm: { profiles: response.llm.profiles } },
    });
    expect(result).toHaveProperty("llm");
    expectOneCommitCycle();
    expect(savedProfile("balanced")).toEqual({
      source: "managed",
      status: "disabled",
    });
    // Echoes of absent defaults reduce to a no-op managed stub.
    expect(savedProfile("quality-optimized")).toEqual({ source: "managed" });
    expect(savedProfile("my-custom")).toEqual({
      provider: "openai",
      model: "gpt-4o",
      source: "user",
    });
  });

  test("creating a new profile under a default name is rejected", async () => {
    rawConfig = { llm: { profiles: {} } };
    await expect(
      patchRoute.handler({
        body: {
          llm: {
            profiles: {
              balanced: { source: "user", provider: "openai", model: "gpt-4o" },
            },
          },
        },
      }),
    ).rejects.toThrow(
      'Cannot create profile "balanced" — the name is reserved for a code-defined default profile.',
    );
    expectNothingCommitted();
  });

  test("writing content to an absent default name is rejected", async () => {
    rawConfig = { llm: { profiles: {} } };
    await expect(
      patchRoute.handler({
        body: {
          llm: {
            profiles: {
              "cost-optimized": { source: "managed", model: "gpt-4o" },
            },
          },
        },
      }),
    ).rejects.toThrow(
      'Cannot edit managed profile "cost-optimized" fields [model].',
    );
    expectNothingCommitted();
  });

  test("disabling an absent default via a generic write is rejected", async () => {
    rawConfig = { llm: { profiles: {} } };
    await expect(
      patchRoute.handler({
        body: {
          llm: {
            profiles: { balanced: { source: "managed", status: "disabled" } },
          },
        },
      }),
    ).rejects.toThrow('Cannot disable managed profile "balanced".');
    expectNothingCommitted();
  });

  test("PUT status re-enable on an absent always-available default creates a thin managed stub", async () => {
    rawConfig = { llm: { profiles: {} } };
    const result = await replaceRoute.handler({
      pathParams: { name: "balanced" },
      body: { status: "active" },
    });
    expect(result).toEqual({ ok: true });
    expect(savedProfile("balanced")).toEqual({
      source: "managed",
      status: "active",
    });
  });

  test("PUT on absent flag-gated os-beta is still rejected", async () => {
    rawConfig = { llm: { profiles: {} } };
    await expect(
      replaceRoute.handler({
        pathParams: { name: "os-beta" },
        body: { status: "active" },
      }),
    ).rejects.toThrow(
      'Profile "os-beta" is not currently available and cannot be edited.',
    );
    expectNothingCommitted();
  });

  test("an existing user-source shadow of a default name stays editable", async () => {
    rawConfig = {
      llm: {
        profiles: {
          balanced: { source: "user", provider: "openai", model: "gpt-4o" },
        },
      },
    };
    const result = await patchRoute.handler({
      body: { llm: { profiles: { balanced: { model: "gpt-5.4" } } } },
    });
    expect(result).toHaveProperty("llm");
    expectOneCommitCycle();
    expect(savedProfile("balanced").model).toBe("gpt-5.4");
  });
});

describe("code-owned default profiles — leaf SET source stamping", () => {
  test("a leaf SET creating a managed entry stamps the managed marker", async () => {
    rawConfig = { llm: { profiles: {} } };
    const result = await setRoute.handler({
      body: { path: "llm.profiles.balanced.status", value: "active" },
    });
    expect(result).toEqual({ ok: true });
    expect(savedProfile("balanced")).toEqual({
      source: "managed",
      status: "active",
    });
  });

  test("a leaf SET on an existing user shadow does not stamp it managed", async () => {
    rawConfig = {
      llm: {
        profiles: {
          balanced: { source: "user", provider: "openai", model: "gpt-4o" },
        },
      },
    };
    const result = await setRoute.handler({
      body: { path: "llm.profiles.balanced.model", value: "gpt-5.4" },
    });
    expect(result).toEqual({ ok: true });
    // Write normalization completes the changed user entry; the guard's
    // concern is only that `source` stays user-owned.
    expect(savedProfile("balanced")).toMatchObject({
      source: "user",
      provider: "openai",
      model: "gpt-5.4",
    });
    expect(savedProfile("balanced").source).toBe("user");
  });

  test("a leaf SET writing content to an absent default is rejected", async () => {
    rawConfig = { llm: { profiles: {} } };
    await expect(
      setRoute.handler({
        body: { path: "llm.profiles.balanced.model", value: "gpt-4o" },
      }),
    ).rejects.toThrow(BadRequestError);
    expectNothingCommitted();
  });
});

describe("code-owned default profiles — echoes over stale on-disk bodies", () => {
  // An overlay can persist a managed entry whose content differs from the
  // catalog; GET serves catalog content, so a client echo carries values
  // that match neither nothing — they match the wire view. The round-trip
  // must still be a no-op.
  const staleBody = {
    source: "managed",
    provider: "anthropic",
    model: "claude-sonnet",
    maxTokens: 16000,
  };

  test("GET → PATCH round-trip over a stale managed body is accepted and changes nothing", async () => {
    rawConfig = { llm: { profiles: { balanced: structuredClone(staleBody) } } };
    const response = (await getRoute.handler({})) as Record<string, any>;
    // The wire view serves catalog content, not the stale body.
    expect(response.llm.profiles.balanced.model).toBe(
      "accounts/fireworks/models/glm-5p2",
    );
    const result = await patchRoute.handler({
      body: { llm: { profiles: response.llm.profiles } },
    });
    expect(result).toHaveProperty("llm");
    expectOneCommitCycle();
    expect(savedProfile("balanced")).toEqual(staleBody);
  });

  test("GET → SET llm round-trip over a stale managed body is accepted and changes nothing", async () => {
    rawConfig = { llm: { profiles: { balanced: structuredClone(staleBody) } } };
    const response = (await getRoute.handler({})) as Record<string, any>;
    const result = await setRoute.handler({
      body: { path: "llm.profiles", value: response.llm.profiles },
    });
    expect(result).toEqual({ ok: true });
    expect(savedProfile("balanced")).toEqual(staleBody);
  });

  test("a genuine content edit over a stale managed body is still rejected", async () => {
    rawConfig = { llm: { profiles: { balanced: structuredClone(staleBody) } } };
    await expect(
      patchRoute.handler({
        body: {
          llm: { profiles: { balanced: { model: "some-other-model" } } },
        },
      }),
    ).rejects.toThrow(BadRequestError);
    expectNothingCommitted();
  });
});
