/**
 * Tests that built-in (managed) inference profiles ("quality-optimized",
 * "balanced", "cost-optimized", ...) cannot be reshaped or deleted via the
 * config write routes:
 *
 * - PUT /v1/config/llm/profiles/:name allows only label/status, persisted as
 *   sparse `llm.profileOverrides` entries (never under `llm.profiles`).
 * - PATCH /v1/config re-routes built-in label/status edits into
 *   `llm.profileOverrides` and drops every other built-in field, so clients
 *   that round-trip `GET /v1/config` output (which contains the merged
 *   built-in entries) keep working without materializing built-ins on disk.
 * - POST /v1/config/set gets the same treatment with path-aware handling.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "./helpers/mock-logger.js";

mock.module("../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

let savedRaw: Record<string, unknown> | null = null;
let rawConfig: Record<string, unknown>;

function makeDefaultRawConfig(): Record<string, unknown> {
  return {
    llm: {
      profiles: {
        "quality-optimized": {
          provider: "anthropic",
          model: "claude-sonnet",
        },
        balanced: { provider: "anthropic", model: "claude-sonnet" },
        "cost-optimized": { provider: "anthropic", model: "claude-haiku" },
        "my-custom": { provider: "openai", model: "gpt-4o" },
      },
    },
  };
}

// Note: unspecified exports (deepMergeOverwrite, applyBuiltinProfiles,
// setNestedValue, ...) fall through to the real loader module, so merge and
// built-in-profile semantics in these tests match production.
mock.module("../config/loader.js", () => ({
  loadRawConfig: () => structuredClone(rawConfig),
  saveRawConfig: (raw: Record<string, unknown>) => {
    savedRaw = raw;
  },
  getConfig: () => rawConfig,
  invalidateConfigCache: () => {},
  withSuppressedConfigDiskWrites: async (fn: () => unknown) => fn(),
  withSuppressedConfigDiskWritesSync: (fn: () => unknown) => fn(),
}));

mock.module("../providers/registry.js", () => ({
  initializeProviders: async () => {},
}));

mock.module("../memory/embedding-backend.js", () => ({
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

import { applyBuiltinProfiles } from "../config/loader.js";
import { ROUTES } from "../runtime/routes/conversation-query-routes.js";
import { BadRequestError } from "../runtime/routes/errors.js";

const replaceRoute = ROUTES.find(
  (r) => r.operationId === "config_llm_profiles_replace",
)!;

const patchRoute = ROUTES.find((r) => r.operationId === "config_patch")!;

const setRoute = ROUTES.find((r) => r.operationId === "config_set")!;

const getRoute = ROUTES.find((r) => r.operationId === "config_get")!;

beforeEach(() => {
  rawConfig = makeDefaultRawConfig();
  savedRaw = null;
});

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
        "Only label and status may be edited; duplicate to a custom profile to change other fields.",
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
  // Built-in label/status edits persist as sparse `llm.profileOverrides`
  // entries; nothing is ever written under `llm.profiles` for a built-in
  // name. Null is the "explicitly cleared" sentinel: it is stored when the
  // merge layer needs it to mask a stale label/status still carried by a
  // transition-state materialized entry, and otherwise just removes any
  // stored override key (for `status`, an absent and an "active" baseline
  // are both already equivalent to cleared). An absent key leaves the
  // existing override key untouched.
  // -------------------------------------------------------------------------

  test("PUT { label: 'X' } lands in profileOverrides, leaving llm.profiles untouched", async () => {
    savedRaw = null;
    const result = await replaceRoute.handler({
      pathParams: { name: "balanced" },
      body: { label: "My Balanced" },
    });
    expect(result).toEqual({ ok: true });
    const saved = savedRaw as unknown as Record<string, any>;
    expect(saved.llm.profileOverrides.balanced).toEqual({
      label: "My Balanced",
    });
    // The transition-state materialized entry is not the write target.
    expect(saved.llm.profiles.balanced).toEqual({
      provider: "anthropic",
      model: "claude-sonnet",
    });
  });

  test("PUT { label: null } stores the null sentinel in profileOverrides", async () => {
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
        profileOverrides: { balanced: { label: "My Custom Name" } },
      },
    };
    const result = await replaceRoute.handler({
      pathParams: { name: "balanced" },
      body: { label: null },
    });
    expect(result).toEqual({ ok: true });
    const saved = savedRaw as unknown as Record<string, any>;
    // Key present with null — masks the stale materialized label at merge
    // time instead of letting it resurface.
    expect(saved.llm.profileOverrides.balanced).toEqual({ label: null });
    // The materialized entry's fields are untouched by the PUT.
    expect(saved.llm.profiles.balanced).toEqual({
      provider: "anthropic",
      model: "claude-sonnet",
      label: "My Custom Name",
      source: "managed",
    });
  });

  test("PUT { status: null } removes the stored status key, leaving other override keys untouched", async () => {
    savedRaw = null;
    rawConfig = {
      llm: {
        profiles: {
          "quality-optimized": { provider: "anthropic", model: "claude-opus" },
        },
        profileOverrides: {
          "quality-optimized": { label: "Keep Me", status: "disabled" },
        },
      },
    };
    const result = await replaceRoute.handler({
      pathParams: { name: "quality-optimized" },
      body: { status: null },
    });
    expect(result).toEqual({ ok: true });
    const saved = savedRaw as unknown as Record<string, any>;
    // The materialized entry carries no status, so the no-override baseline
    // is already active-by-absence: clearing removes the stored "disabled"
    // key outright rather than storing a redundant null sentinel. The
    // absent label key left the existing label override alone.
    expect(saved.llm.profileOverrides["quality-optimized"]).toEqual({
      label: "Keep Me",
    });
  });

  test("PUT { label: null, status: null } clears both in a single request", async () => {
    savedRaw = null;
    rawConfig = {
      llm: {
        profileOverrides: {
          "cost-optimized": { label: "Speed (Custom)", status: "disabled" },
        },
      },
    };
    const result = await replaceRoute.handler({
      pathParams: { name: "cost-optimized" },
      body: { label: null, status: null },
    });
    expect(result).toEqual({ ok: true });
    const saved = savedRaw as unknown as Record<string, any>;
    // label null masks the template default, so it persists as the
    // sentinel; status null against an absent baseline just removes the
    // stored "disabled" key.
    expect(saved.llm.profileOverrides["cost-optimized"]).toEqual({
      label: null,
    });
  });

  test("PUT { label: null, status: 'disabled' } mixes clear + set in one call", async () => {
    savedRaw = null;
    rawConfig = {
      llm: {
        profileOverrides: { balanced: { label: "Custom Label" } },
      },
    };
    const result = await replaceRoute.handler({
      pathParams: { name: "balanced" },
      body: { label: null, status: "disabled" },
    });
    expect(result).toEqual({ ok: true });
    const saved = savedRaw as unknown as Record<string, any>;
    expect(saved.llm.profileOverrides.balanced).toEqual({
      label: null,
      status: "disabled",
    });
  });

  // -------------------------------------------------------------------------
  // Skip-equal rules: only genuine user deviations become overrides. The
  // first-party editors (web profile-editor-modal, macOS SettingsStore)
  // always send BOTH keys, so an unchanged key must not be pinned as a
  // permanent override — that would freeze the current template default and
  // block future template relabels from propagating.
  // -------------------------------------------------------------------------

  /** Effective merged entry for a built-in, as `GET /v1/config` reports it. */
  async function effectiveEntry(name: string): Promise<Record<string, any>> {
    const got = (await getRoute.handler({})) as Record<string, any>;
    return got.llm.profiles[name];
  }

  test("PUT echoing the effective label and active status creates no override", async () => {
    const { label } = await effectiveEntry("balanced");
    const result = await replaceRoute.handler({
      pathParams: { name: "balanced" },
      body: { label, status: "active" },
    });
    expect(result).toEqual({ ok: true });
    const saved = savedRaw as unknown as Record<string, any>;
    expect(saved.llm.profileOverrides).toBeUndefined();
  });

  test("PUT status toggle does not pin the unchanged template label", async () => {
    const { label } = await effectiveEntry("balanced");
    await replaceRoute.handler({
      pathParams: { name: "balanced" },
      body: { label, status: "disabled" },
    });
    const saved = savedRaw as unknown as Record<string, any>;
    expect(saved.llm.profileOverrides.balanced).toEqual({
      status: "disabled",
    });
  });

  test("PUT label rename does not pin status 'active'", async () => {
    await replaceRoute.handler({
      pathParams: { name: "balanced" },
      body: { label: "My Balanced", status: "active" },
    });
    const saved = savedRaw as unknown as Record<string, any>;
    expect(saved.llm.profileOverrides.balanced).toEqual({
      label: "My Balanced",
    });
  });

  test("PUT echoing a stored override value keeps the override (rule a)", async () => {
    rawConfig = {
      llm: { profileOverrides: { balanced: { label: "Mine" } } },
    };
    await replaceRoute.handler({
      pathParams: { name: "balanced" },
      body: { label: "Mine", status: "active" },
    });
    const saved = savedRaw as unknown as Record<string, any>;
    expect(saved.llm.profileOverrides.balanced).toEqual({ label: "Mine" });
  });

  test("PUT restoring the template label removes the stored override key instead of pinning it (rule c)", async () => {
    const { label: templateLabel } = await effectiveEntry("balanced");
    rawConfig = {
      llm: { profileOverrides: { balanced: { label: "Mine" } } },
    };
    await replaceRoute.handler({
      pathParams: { name: "balanced" },
      body: { label: templateLabel, status: "disabled" },
    });
    const saved = savedRaw as unknown as Record<string, any>;
    expect(saved.llm.profileOverrides.balanced).toEqual({
      status: "disabled",
    });
  });

  test("PUT that clears the last override key deletes the entry and the map", async () => {
    rawConfig = {
      llm: { profileOverrides: { balanced: { status: "disabled" } } },
    };
    await replaceRoute.handler({
      pathParams: { name: "balanced" },
      body: { status: "active" },
    });
    const saved = savedRaw as unknown as Record<string, any>;
    expect(saved.llm.profileOverrides).toBeUndefined();
  });

  test("PUT clears a redundant pin equal to the template default (self-heal)", async () => {
    const { label: templateLabel } = await effectiveEntry("balanced");
    // A pin left behind by the pre-fix PUT route: the stored label equals
    // the template default exactly.
    rawConfig = {
      llm: { profileOverrides: { balanced: { label: templateLabel } } },
    };
    await replaceRoute.handler({
      pathParams: { name: "balanced" },
      body: { label: templateLabel, status: "disabled" },
    });
    const saved = savedRaw as unknown as Record<string, any>;
    expect(saved.llm.profileOverrides.balanced).toEqual({
      status: "disabled",
    });
  });

  test("PUT { status: 'active' } over a transition-state materialized 'disabled' still stores the override", async () => {
    // The no-override baseline includes the materialized entry's lifted
    // status, so "active" here is a genuine deviation — skipping it would
    // leave the profile disabled.
    rawConfig = {
      llm: {
        profiles: {
          balanced: {
            provider: "anthropic",
            model: "claude-sonnet",
            status: "disabled",
            source: "managed",
          },
        },
      },
    };
    await replaceRoute.handler({
      pathParams: { name: "balanced" },
      body: { status: "active" },
    });
    const saved = savedRaw as unknown as Record<string, any>;
    expect(saved.llm.profileOverrides.balanced).toEqual({ status: "active" });
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
    expect(result).toEqual({ ok: true });
  });

  test("allows deletion of a user-defined profile via null", async () => {
    savedRaw = null;
    const result = await patchRoute.handler({
      body: { llm: { profiles: { "my-custom": null } } },
    });
    expect(result).toEqual({ ok: true });
  });

  test("allows non-profile config patches", async () => {
    const result = await patchRoute.handler({
      body: { someOtherKey: "value" },
    });
    expect(result).toEqual({ ok: true });
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

    expect(result).toEqual({ ok: true });
    expect(savedRaw).toEqual({
      ingress: {
        publicBaseUrl: "https://manual.example.test",
        publicBaseUrlManagedBy: "velay",
      },
    });
  });

  test("drops non-overridable fields from a managed profile patch instead of persisting them", async () => {
    savedRaw = null;
    const result = await patchRoute.handler({
      body: {
        llm: {
          profiles: { "quality-optimized": { provider: "openai" } },
        },
      },
    });
    expect(result).toEqual({ ok: true });
    const saved = savedRaw as unknown as Record<string, any>;
    // The on-disk entry is exactly what the fixture had — the patched
    // provider never landed, and no override store was created.
    expect(saved.llm.profiles["quality-optimized"]).toEqual({
      provider: "anthropic",
      model: "claude-sonnet",
    });
    expect(saved.llm.profileOverrides).toBeUndefined();
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
// PATCH /v1/config — built-in profile writes are re-routed to profileOverrides
// ---------------------------------------------------------------------------

describe("PATCH /v1/config — built-in profile sanitization", () => {
  test("built-in label/status edits land in profileOverrides, not llm.profiles", async () => {
    rawConfig = {
      llm: {
        profiles: { "my-custom": { provider: "openai", model: "gpt-4o" } },
      },
    };
    const result = await patchRoute.handler({
      body: {
        llm: { profiles: { balanced: { label: "X", status: "disabled" } } },
      },
    });
    expect(result).toEqual({ ok: true });
    const saved = savedRaw as unknown as Record<string, any>;
    expect(saved.llm.profiles.balanced).toBeUndefined();
    expect(saved.llm.profileOverrides.balanced).toEqual({
      label: "X",
      status: "disabled",
    });
    // Custom profiles are untouched by the sanitizer.
    expect(saved.llm.profiles["my-custom"]).toEqual({
      provider: "openai",
      model: "gpt-4o",
    });
  });

  test("PATCH with { model: 'foo' } on a built-in drops the field from the write", async () => {
    rawConfig = {
      llm: {
        profiles: { "my-custom": { provider: "openai", model: "gpt-4o" } },
      },
    };
    const result = await patchRoute.handler({
      body: { llm: { profiles: { balanced: { model: "foo" } } } },
    });
    expect(result).toEqual({ ok: true });
    const saved = savedRaw as unknown as Record<string, any>;
    // Nothing of the built-in write survives: no materialized entry, no
    // override entry.
    expect(saved.llm.profiles.balanced).toBeUndefined();
    expect(saved.llm.profileOverrides).toBeUndefined();
  });

  test("explicit body profileOverrides win over values lifted from a merged profiles entry", async () => {
    rawConfig = { llm: { profiles: {} } };
    const result = await patchRoute.handler({
      body: {
        llm: {
          profiles: { balanced: { label: "Lifted" } },
          profileOverrides: { balanced: { label: "Explicit" } },
        },
      },
    });
    expect(result).toEqual({ ok: true });
    const saved = savedRaw as unknown as Record<string, any>;
    expect(saved.llm.profileOverrides.balanced).toEqual({ label: "Explicit" });
    expect(saved.llm.profiles.balanced).toBeUndefined();
  });

  test("PATCH { label: null } persists the sentinel and masks a stale materialized label", async () => {
    // No llm.profileOverrides on disk: the lifted null must not flow through
    // deepMergeOverwrite, whose stripNullLeaves would empty the fresh
    // subtree and lose the clear.
    rawConfig = {
      llm: {
        profiles: {
          balanced: {
            provider: "anthropic",
            model: "claude-drifted",
            label: "Stale Custom",
            source: "managed",
          },
        },
      },
    };
    const result = await patchRoute.handler({
      body: { llm: { profiles: { balanced: { label: null } } } },
    });
    expect(result).toEqual({ ok: true });
    const saved = savedRaw as unknown as Record<string, any>;
    expect(saved.llm.profileOverrides.balanced).toEqual({ label: null });
    // At merge time the stored null outranks the stale materialized label:
    // the effective entry reports the cleared state, not "Stale Custom".
    const effective = structuredClone(saved);
    applyBuiltinProfiles(effective);
    expect(effective.llm.profiles.balanced.label).toBeNull();
  });

  test("PATCH { label: null } persists on an existing override entry, leaving other keys untouched", async () => {
    rawConfig = {
      llm: {
        profiles: {
          balanced: {
            provider: "anthropic",
            model: "claude-drifted",
            label: "Stale Custom",
            source: "managed",
          },
        },
        profileOverrides: { balanced: { status: "disabled" } },
      },
    };
    const result = await patchRoute.handler({
      body: { llm: { profiles: { balanced: { label: null } } } },
    });
    expect(result).toEqual({ ok: true });
    const saved = savedRaw as unknown as Record<string, any>;
    expect(saved.llm.profileOverrides.balanced).toEqual({
      status: "disabled",
      label: null,
    });
  });

  test("an unmodified GET → PATCH round trip creates no overrides and leaves raw profiles unchanged", async () => {
    const got = (await getRoute.handler({})) as Record<string, any>;
    const result = await patchRoute.handler({
      body: { llm: { profiles: got.llm.profiles } },
    });
    expect(result).toEqual({ ok: true });
    const saved = savedRaw as unknown as Record<string, any>;
    // No override materialized from round-tripping the merged template
    // values, and the on-disk (transition-state) entry is exactly what was
    // there before.
    expect(saved.llm.profileOverrides).toBeUndefined();
    expect(saved.llm.profiles.balanced).toEqual({
      provider: "anthropic",
      model: "claude-sonnet",
    });
  });
});

// ---------------------------------------------------------------------------
// POST /v1/config/set — built-in profile writes are re-routed to
// profileOverrides with path-aware replace semantics
// ---------------------------------------------------------------------------

describe("POST /v1/config/set — built-in profile sanitization", () => {
  test("single-field set on a built-in routes to profileOverrides and leaves the materialized entry untouched", async () => {
    const result = await setRoute.handler({
      body: { path: "llm.profiles.balanced.label", value: "Renamed" },
    });
    expect(result).toEqual({ ok: true });
    const saved = savedRaw as unknown as Record<string, any>;
    expect(saved.llm.profileOverrides.balanced).toEqual({ label: "Renamed" });
    expect(saved.llm.profiles.balanced).toEqual({
      provider: "anthropic",
      model: "claude-sonnet",
    });
  });

  test("set of a non-overridable built-in field is dropped", async () => {
    const result = await setRoute.handler({
      body: { path: "llm.profiles.balanced.maxTokens", value: 999 },
    });
    expect(result).toEqual({ ok: true });
    const saved = savedRaw as unknown as Record<string, any>;
    expect(saved.llm.profiles.balanced).toEqual({
      provider: "anthropic",
      model: "claude-sonnet",
    });
    expect(saved.llm.profileOverrides).toBeUndefined();
  });

  test("whole-entry set on a built-in lifts label/status and strips the entry from disk", async () => {
    const result = await setRoute.handler({
      body: {
        path: "llm.profiles.balanced",
        value: { label: "Mine", status: "disabled", model: "smuggled" },
      },
    });
    expect(result).toEqual({ ok: true });
    const saved = savedRaw as unknown as Record<string, any>;
    expect(saved.llm.profiles.balanced).toBeUndefined();
    expect(saved.llm.profileOverrides.balanced).toEqual({
      label: "Mine",
      status: "disabled",
    });
  });

  test("set llm.profiles replaces customs and converts built-ins to overrides", async () => {
    const result = await setRoute.handler({
      body: {
        path: "llm.profiles",
        value: {
          balanced: { label: "B", model: "smuggled" },
          "new-custom": { provider: "openai", model: "gpt-4o" },
        },
      },
    });
    expect(result).toEqual({ ok: true });
    const saved = savedRaw as unknown as Record<string, any>;
    expect(saved.llm.profiles).toEqual({
      "new-custom": { provider: "openai", model: "gpt-4o" },
    });
    expect(saved.llm.profileOverrides.balanced).toEqual({ label: "B" });
  });

  test("an unmodified GET → set llm round trip persists no built-ins and creates no overrides", async () => {
    const got = (await getRoute.handler({})) as Record<string, any>;
    const result = await setRoute.handler({
      body: { path: "llm", value: got.llm },
    });
    expect(result).toEqual({ ok: true });
    const saved = savedRaw as unknown as Record<string, any>;
    for (const name of [
      "auto",
      "balanced",
      "quality-optimized",
      "cost-optimized",
      "balanced-economy",
    ]) {
      expect(saved.llm.profiles[name]).toBeUndefined();
    }
    expect(saved.llm.profileOverrides).toBeUndefined();
    expect(saved.llm.profiles["my-custom"]).toMatchObject({
      provider: "openai",
      model: "gpt-4o",
    });
  });

  test("a round-tripped GET body lifts a transition-state seeder status instead of losing it", async () => {
    rawConfig = {
      llm: {
        profiles: {
          balanced: {
            provider: "anthropic",
            model: "claude-drifted",
            status: "disabled",
            source: "managed",
          },
          "my-custom": { provider: "openai", model: "gpt-4o" },
        },
      },
    };
    const got = (await getRoute.handler({})) as Record<string, any>;
    const result = await setRoute.handler({
      body: { path: "llm", value: got.llm },
    });
    expect(result).toEqual({ ok: true });
    const saved = savedRaw as unknown as Record<string, any>;
    expect(saved.llm.profiles.balanced).toBeUndefined();
    // The materialized entry's status survived the strip as an override; the
    // unmodified template label did not become one.
    expect(saved.llm.profileOverrides.balanced).toEqual({
      status: "disabled",
    });
    expect(saved.llm.profileOverrides["quality-optimized"]).toBeUndefined();
  });

  test("set llm.profiles.<builtin> to null is still rejected", async () => {
    await expect(
      setRoute.handler({
        body: { path: "llm.profiles.balanced", value: null },
      }),
    ).rejects.toThrow('Cannot delete managed profile "balanced".');
  });

  test("set of an unrelated path leaves materialized built-in entries alone", async () => {
    const result = await setRoute.handler({
      body: { path: "heartbeat.enabled", value: true },
    });
    expect(result).toEqual({ ok: true });
    const saved = savedRaw as unknown as Record<string, any>;
    expect(saved.heartbeat).toEqual({ enabled: true });
    expect(saved.llm.profiles.balanced).toEqual({
      provider: "anthropic",
      model: "claude-sonnet",
    });
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/config — llm.profileOverrides payloads are validated against
// ProfileOverrideEntry. An illegal field would never take effect but poisons
// every subsequent config load, whose Zod-issue cleanup can drop the ENTIRE
// entry — taking the user's legitimate label/status with it.
// ---------------------------------------------------------------------------

describe("PATCH /v1/config — profileOverrides payload guard", () => {
  test("drops illegal fields from an override entry and keeps legal ones", async () => {
    const result = await patchRoute.handler({
      body: {
        llm: { profileOverrides: { balanced: { model: "x", label: "Mine" } } },
      },
    });
    expect(result).toEqual({ ok: true });
    const saved = savedRaw as unknown as Record<string, any>;
    expect(saved.llm.profileOverrides.balanced).toEqual({ label: "Mine" });
  });

  test("an entry with only illegal fields creates no override entry", async () => {
    const result = await patchRoute.handler({
      body: { llm: { profileOverrides: { balanced: { model: "x" } } } },
    });
    expect(result).toEqual({ ok: true });
    const saved = savedRaw as unknown as Record<string, any>;
    expect(saved.llm.profileOverrides).toBeUndefined();
  });

  test("an illegal value (empty label) is dropped", async () => {
    const result = await patchRoute.handler({
      body: { llm: { profileOverrides: { balanced: { label: "" } } } },
    });
    expect(result).toEqual({ ok: true });
    const saved = savedRaw as unknown as Record<string, any>;
    expect(saved.llm.profileOverrides).toBeUndefined();
  });

  test("a null entry clears an existing override and leaves no empty map", async () => {
    rawConfig = {
      llm: { profileOverrides: { balanced: { label: "Mine" } } },
    };
    const result = await patchRoute.handler({
      body: { llm: { profileOverrides: { balanced: null } } },
    });
    expect(result).toEqual({ ok: true });
    const saved = savedRaw as unknown as Record<string, any>;
    expect(saved.llm.profileOverrides).toBeUndefined();
  });

  test("a fresh { label: null } entry persists the null clear sentinel", async () => {
    // Override fragments bypass deepMergeOverwrite (whose stripNullLeaves
    // would empty a null-only subtree assigned to a missing key): for the
    // override store the null IS the data.
    const result = await patchRoute.handler({
      body: { llm: { profileOverrides: { balanced: { label: null } } } },
    });
    expect(result).toEqual({ ok: true });
    const saved = savedRaw as unknown as Record<string, any>;
    expect(saved.llm.profileOverrides.balanced).toEqual({ label: null });
  });

  test("an explicit { status: null } field persists as the clear sentinel", async () => {
    const result = await patchRoute.handler({
      body: { llm: { profileOverrides: { balanced: { status: null } } } },
    });
    expect(result).toEqual({ ok: true });
    const saved = savedRaw as unknown as Record<string, any>;
    expect(saved.llm.profileOverrides.balanced).toEqual({ status: null });
  });

  test("unknown profile names with legal fields are allowed (open record; only fields are validated)", async () => {
    const result = await patchRoute.handler({
      body: {
        llm: { profileOverrides: { "future-profile": { label: "ok" } } },
      },
    });
    expect(result).toEqual({ ok: true });
    const saved = savedRaw as unknown as Record<string, any>;
    expect(saved.llm.profileOverrides["future-profile"]).toEqual({
      label: "ok",
    });
  });

  test("non-object entries are dropped", async () => {
    const result = await patchRoute.handler({
      body: { llm: { profileOverrides: { balanced: "junk" } } },
    });
    expect(result).toEqual({ ok: true });
    const saved = savedRaw as unknown as Record<string, any>;
    expect(saved.llm.profileOverrides).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// POST /v1/config/set — llm.profileOverrides paths get the same guard with
// path-aware replace semantics.
// ---------------------------------------------------------------------------

describe("POST /v1/config/set — profileOverrides payload guard", () => {
  test("set llm.profileOverrides.<name>.<field> with an illegal field is dropped", async () => {
    const result = await setRoute.handler({
      body: { path: "llm.profileOverrides.balanced.model", value: "x" },
    });
    expect(result).toEqual({ ok: true });
    const saved = savedRaw as unknown as Record<string, any>;
    expect(saved.llm.profileOverrides).toBeUndefined();
  });

  test("set llm.profileOverrides.<name>.<field> with a legal value persists", async () => {
    const result = await setRoute.handler({
      body: { path: "llm.profileOverrides.balanced.label", value: "Renamed" },
    });
    expect(result).toEqual({ ok: true });
    const saved = savedRaw as unknown as Record<string, any>;
    expect(saved.llm.profileOverrides.balanced).toEqual({ label: "Renamed" });
  });

  test("set llm.profileOverrides.<name>.<field> with an illegal value (empty label) is dropped", async () => {
    const result = await setRoute.handler({
      body: { path: "llm.profileOverrides.balanced.label", value: "" },
    });
    expect(result).toEqual({ ok: true });
    const saved = savedRaw as unknown as Record<string, any>;
    expect(saved.llm.profileOverrides).toBeUndefined();
  });

  test("a deeper path under an override field is dropped without clobbering the stored value", async () => {
    rawConfig = {
      llm: { profileOverrides: { balanced: { label: "Keep" } } },
    };
    const result = await setRoute.handler({
      body: { path: "llm.profileOverrides.balanced.label.deep", value: "x" },
    });
    expect(result).toEqual({ ok: true });
    const saved = savedRaw as unknown as Record<string, any>;
    expect(saved.llm.profileOverrides.balanced).toEqual({ label: "Keep" });
  });

  test("set llm.profileOverrides.<name> sanitizes the entry, replace-style", async () => {
    const result = await setRoute.handler({
      body: {
        path: "llm.profileOverrides.balanced",
        value: { label: "Mine", model: "smuggled" },
      },
    });
    expect(result).toEqual({ ok: true });
    const saved = savedRaw as unknown as Record<string, any>;
    expect(saved.llm.profileOverrides.balanced).toEqual({ label: "Mine" });
  });

  test("set llm.profileOverrides.<name> to only-illegal fields removes the entry", async () => {
    rawConfig = {
      llm: { profileOverrides: { balanced: { label: "Old" } } },
    };
    const result = await setRoute.handler({
      body: { path: "llm.profileOverrides.balanced", value: { model: "x" } },
    });
    expect(result).toEqual({ ok: true });
    const saved = savedRaw as unknown as Record<string, any>;
    // Replace semantics: the old entry was replaced by the (fully illegal)
    // payload, which sanitizes to nothing.
    expect(saved.llm.profileOverrides).toBeUndefined();
  });

  test("set llm.profileOverrides.<name> to null clears the entry", async () => {
    rawConfig = {
      llm: { profileOverrides: { balanced: { label: "Old" } } },
    };
    const result = await setRoute.handler({
      body: { path: "llm.profileOverrides.balanced", value: null },
    });
    expect(result).toEqual({ ok: true });
    const saved = savedRaw as unknown as Record<string, any>;
    expect(saved.llm.profileOverrides).toBeUndefined();
  });

  test("set llm.profileOverrides sanitizes the whole map", async () => {
    const result = await setRoute.handler({
      body: {
        path: "llm.profileOverrides",
        value: {
          balanced: { status: "disabled", maxTokens: 1 },
          "future-profile": { label: "ok" },
          junk: "not-an-object",
        },
      },
    });
    expect(result).toEqual({ ok: true });
    const saved = savedRaw as unknown as Record<string, any>;
    expect(saved.llm.profileOverrides).toEqual({
      balanced: { status: "disabled" },
      "future-profile": { label: "ok" },
    });
  });

  test("set llm guards the written subtree's profileOverrides payload", async () => {
    const result = await setRoute.handler({
      body: {
        path: "llm",
        value: {
          profiles: { "my-custom": { provider: "openai", model: "gpt-4o" } },
          profileOverrides: { balanced: { label: "Mine", model: "x" } },
        },
      },
    });
    expect(result).toEqual({ ok: true });
    const saved = savedRaw as unknown as Record<string, any>;
    expect(saved.llm.profileOverrides.balanced).toEqual({ label: "Mine" });
    expect(saved.llm.profiles["my-custom"]).toEqual({
      provider: "openai",
      model: "gpt-4o",
    });
  });
});
