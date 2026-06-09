/**
 * Built-in inference profiles are code-defined and merged into the parsed
 * config at load time (`applyBuiltinProfiles` in `config/loader.ts`):
 *
 * - `getConfig()` / `getConfigReadOnly()` expose all built-ins even when the
 *   raw config has none materialized.
 * - Template fields are authoritative; `llm.profileOverrides` (and, at lower
 *   precedence, label/status on still-materialized transition-state entries)
 *   control only label/status.
 * - Feature-flag-gated built-ins disappear from the effective set when the
 *   flag is off, with activeProfile falling back to `balanced`.
 * - The merge is in-memory only: pure reads never write built-in entries
 *   back to config.json.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — declared before imports that depend on platform/logger
// ---------------------------------------------------------------------------

const WORKSPACE_DIR = process.env.VELLUM_WORKSPACE_DIR!;
const CONFIG_PATH = join(WORKSPACE_DIR, "config.json");

function makeLoggerStub(): Record<string, unknown> {
  const stub: Record<string, unknown> = {};
  for (const m of [
    "info",
    "warn",
    "error",
    "debug",
    "trace",
    "fatal",
    "silent",
    "child",
  ]) {
    stub[m] = m === "child" ? () => makeLoggerStub() : () => {};
  }
  return stub;
}

mock.module("../util/logger.js", () => ({
  getLogger: () => makeLoggerStub(),
}));

afterAll(() => {
  mock.restore();
});

import {
  clearFeatureFlagOverridesCache,
  refreshOverridesFromGateway,
} from "../config/assistant-feature-flags.js";
import {
  AUTO_PROFILE_KEY,
  MANAGED_PROFILE_TEMPLATES,
  materializeProfile,
} from "../config/builtin-inference-profiles.js";
import {
  getConfig,
  getConfigReadOnly,
  invalidateConfigCache,
} from "../config/loader.js";
import type { ProfileEntry } from "../config/schemas/llm.js";
import { ROUTES as LLM_CALL_SITES_ROUTES } from "../runtime/routes/llm-call-sites-routes.js";
import type { RouteHandlerArgs } from "../runtime/routes/types.js";
import { setStorePathForTesting } from "./encrypted-store-test-helpers.js";
import { setOverridesForTesting } from "./feature-flag-test-helpers.js";
import { mockGatewayIpc, resetMockGatewayIpc } from "./mock-gateway-ipc.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BUILTIN_NAMES = [
  AUTO_PROFILE_KEY,
  ...Object.keys(MANAGED_PROFILE_TEMPLATES),
];

/** Registry flag gating the `balanced-economy` built-in
 * (`defaultEnabled: true` — a remote kill switch). */
const BALANCED_ECONOMY_FLAG = "balanced-economy-profile";

function ensureTestDir(): void {
  const dirs = [
    WORKSPACE_DIR,
    join(WORKSPACE_DIR, "data"),
    join(WORKSPACE_DIR, "data", "memory"),
    join(WORKSPACE_DIR, "data", "logs"),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

function resetWorkspace(): void {
  if (existsSync(WORKSPACE_DIR)) {
    for (const name of readdirSync(WORKSPACE_DIR)) {
      rmSync(join(WORKSPACE_DIR, name), { recursive: true, force: true });
    }
  }
  ensureTestDir();
}

function writeConfig(config: Record<string, unknown>): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

function readConfigFromDisk(): Record<string, unknown> {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
}

function templateEntry(name: string): ProfileEntry {
  const template = MANAGED_PROFILE_TEMPLATES[name]!;
  return materializeProfile(
    template,
    template.provider,
    template.connectionName,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("config loader — built-in inference profile merge", () => {
  const originalIsPlatform = process.env.IS_PLATFORM;

  beforeEach(() => {
    resetWorkspace();
    setStorePathForTesting(join(WORKSPACE_DIR, "keys.enc"));
    invalidateConfigCache();
    resetMockGatewayIpc();
    // Pin flag state: empty overrides → registry defaults apply, and the
    // gateway IPC retry loop never runs.
    setOverridesForTesting({});
    process.env.IS_PLATFORM = "true";
  });

  afterEach(() => {
    setStorePathForTesting(null);
    invalidateConfigCache();
    clearFeatureFlagOverridesCache();
    resetMockGatewayIpc();
    if (originalIsPlatform === undefined) {
      delete process.env.IS_PLATFORM;
    } else {
      process.env.IS_PLATFORM = originalIsPlatform;
    }
  });

  test("getConfig() exposes all built-ins on an empty raw config, without persisting them", () => {
    const config = getConfig();

    for (const name of BUILTIN_NAMES) {
      expect(config.llm.profiles[name]).toBeDefined();
    }
    expect(config.llm.profiles[AUTO_PROFILE_KEY]!.provider).toBeUndefined();
    expect(config.llm.profiles[AUTO_PROFILE_KEY]!.model).toBeUndefined();

    const expectedBalanced = templateEntry("balanced");
    expect(config.llm.profiles.balanced!.model).toBe(expectedBalanced.model!);
    expect(config.llm.profiles.balanced!.label).toBe("Balanced");
    expect(config.llm.profiles.balanced!.provider_connection).toBe(
      "anthropic-managed",
    );

    expect(config.llm.profileOrder[0]).toBe(AUTO_PROFILE_KEY);
    for (const name of BUILTIN_NAMES) {
      expect(config.llm.profileOrder).toContain(name);
    }
    expect(config.llm.activeProfile).toBe("balanced");

    // First-launch seed wrote schema defaults to disk — WITHOUT the merged
    // built-in entries and without the in-memory activeProfile fallback.
    const onDisk = readConfigFromDisk() as {
      llm?: { profiles?: Record<string, unknown>; activeProfile?: string };
    };
    expect(onDisk.llm?.profiles).toEqual({});
    expect(onDisk.llm?.activeProfile).toBeUndefined();
  });

  test("getConfigReadOnly() returns merged built-ins without creating config.json", () => {
    const config = getConfigReadOnly();

    for (const name of BUILTIN_NAMES) {
      expect(config.llm.profiles[name]).toBeDefined();
    }
    expect(config.llm.activeProfile).toBe("balanced");
    expect(existsSync(CONFIG_PATH)).toBe(false);
  });

  test("off-platform (BYOK) built-ins get the ' (Managed)' label suffix", () => {
    process.env.IS_PLATFORM = "false";

    const config = getConfig();

    expect(config.llm.profiles.balanced!.label).toBe("Balanced (Managed)");
    // `auto` never gets the suffix.
    expect(config.llm.profiles[AUTO_PROFILE_KEY]!.label).toBe("Auto");
  });

  test("llm.profileOverrides label/status are reflected on the merged entry", () => {
    writeConfig({
      llm: {
        profileOverrides: {
          balanced: { label: "My Balanced", status: "disabled" },
        },
      },
    });

    const config = getConfig();

    expect(config.llm.profiles.balanced!.label).toBe("My Balanced");
    expect(config.llm.profiles.balanced!.status).toBe("disabled");
    // Template config fields are untouched by the override.
    expect(config.llm.profiles.balanced!.model).toBe(
      templateEntry("balanced").model!,
    );
  });

  test("stale materialized entry: template model/config win, its label/status are kept as low-precedence overrides", () => {
    writeConfig({
      llm: {
        profiles: {
          balanced: {
            provider: "anthropic",
            provider_connection: "anthropic-managed",
            model: "claude-drifted-model",
            maxTokens: 999,
            temperature: 1.5,
            label: "Renamed Balanced",
            status: "disabled",
            source: "managed",
          },
        },
        activeProfile: "balanced",
      },
    });

    const config = getConfig();
    const balanced = config.llm.profiles.balanced!;
    const expected = templateEntry("balanced");

    // Drifted config fields are discarded — the template is authoritative.
    expect(balanced.model).toBe(expected.model!);
    expect(balanced.maxTokens).toBe(expected.maxTokens!);
    expect(balanced.temperature).toBeUndefined();
    // User-ownable facets carried on the stale entry survive.
    expect(balanced.label).toBe("Renamed Balanced");
    expect(balanced.status).toBe("disabled");
  });

  test("llm.profileOverrides beats a stale materialized entry's label", () => {
    writeConfig({
      llm: {
        profiles: {
          balanced: {
            provider: "anthropic",
            model: "claude-drifted-model",
            label: "Stale Label",
          },
        },
        profileOverrides: {
          balanced: { label: "Override Label" },
        },
      },
    });

    const config = getConfig();

    expect(config.llm.profiles.balanced!.label).toBe("Override Label");
  });

  test("stale seed-default labels are not lifted as overrides: BYOK gets the suffixed default", () => {
    process.env.IS_PLATFORM = "false";
    // Pre-suffix-era seeder wrote the bare template label; the suffix-era
    // seeder wrote the " (Managed)" form. Both are seed artifacts — neither
    // carries user intent, so the resolve-time BYOK default applies.
    writeConfig({
      llm: {
        profiles: {
          balanced: {
            source: "managed",
            provider: "anthropic",
            provider_connection: "anthropic-managed",
            model: "claude-sonnet-4-6",
            label: "Balanced",
          },
          "quality-optimized": {
            source: "managed",
            provider: "anthropic",
            provider_connection: "anthropic-managed",
            label: "Quality (Managed)",
          },
        },
        activeProfile: "balanced",
      },
    });

    const config = getConfig();

    expect(config.llm.profiles.balanced!.label).toBe("Balanced (Managed)");
    expect(config.llm.profiles["quality-optimized"]!.label).toBe(
      "Quality (Managed)",
    );
  });

  test("stale seed-default suffixed label resolves to the bare default on platform", () => {
    writeConfig({
      llm: {
        profiles: {
          balanced: {
            source: "managed",
            provider: "anthropic",
            provider_connection: "anthropic-managed",
            label: "Balanced (Managed)",
          },
        },
        activeProfile: "balanced",
      },
    });

    const config = getConfig();

    expect(config.llm.profiles.balanced!.label).toBe("Balanced");
  });

  test("non-seed stale labels and explicit null are honored as overrides on BYOK", () => {
    process.env.IS_PLATFORM = "false";
    writeConfig({
      llm: {
        profiles: {
          balanced: {
            source: "managed",
            provider: "anthropic",
            provider_connection: "anthropic-managed",
            label: "My Custom Name",
          },
          "quality-optimized": {
            source: "managed",
            provider: "anthropic",
            provider_connection: "anthropic-managed",
            label: null,
          },
        },
        activeProfile: "balanced",
      },
    });

    const config = getConfig();

    expect(config.llm.profiles.balanced!.label).toBe("My Custom Name");
    expect(config.llm.profiles["quality-optimized"]!.label).toBeNull();
  });

  test("llm.profileOverrides label wins over a stale seed-default label", () => {
    process.env.IS_PLATFORM = "false";
    writeConfig({
      llm: {
        profiles: {
          balanced: {
            source: "managed",
            provider: "anthropic",
            provider_connection: "anthropic-managed",
            label: "Balanced",
          },
        },
        profileOverrides: {
          balanced: { label: "Override Label" },
        },
        activeProfile: "balanced",
      },
    });

    const config = getConfig();

    expect(config.llm.profiles.balanced!.label).toBe("Override Label");
  });

  test("the balanced-economy definition is gated by the registry flag", () => {
    expect(MANAGED_PROFILE_TEMPLATES["balanced-economy"]!.featureFlag).toBe(
      BALANCED_ECONOMY_FLAG,
    );
  });

  test("flag-disabled built-in is absent from profiles and profileOrder; activeProfile falls back to balanced", () => {
    setOverridesForTesting({ [BALANCED_ECONOMY_FLAG]: false });
    writeConfig({
      llm: {
        profiles: {
          "balanced-economy": {
            provider: "fireworks",
            model: "kimi-k2p6",
            source: "managed",
          },
        },
        profileOrder: ["auto", "balanced", "balanced-economy"],
        activeProfile: "balanced-economy",
      },
    });

    const config = getConfig();

    expect(config.llm.profiles["balanced-economy"]).toBeUndefined();
    expect(config.llm.profileOrder).not.toContain("balanced-economy");
    expect(config.llm.activeProfile).toBe("balanced");
    // The other built-ins are unaffected.
    expect(config.llm.profiles.balanced).toBeDefined();
    expect(config.llm.profiles["quality-optimized"]).toBeDefined();
  });

  test("flag flip via refreshOverridesFromGateway changes the visible profile set without restart", async () => {
    setOverridesForTesting({ [BALANCED_ECONOMY_FLAG]: true });
    writeConfig({ llm: { activeProfile: "balanced" } });

    expect(getConfig().llm.profiles["balanced-economy"]).toBeDefined();

    // The gateway pushes a flag flip; the refresh must invalidate the
    // parsed-config cache (config.json itself is unchanged, so the file
    // signature alone would keep serving the stale merged set).
    mockGatewayIpc({ [BALANCED_ECONOMY_FLAG]: false });
    await refreshOverridesFromGateway();

    expect(getConfig().llm.profiles["balanced-economy"]).toBeUndefined();
  });

  test("balanced-economy is present by default (registry defaultEnabled: true)", () => {
    // setOverridesForTesting({}) in beforeEach pins "no remote overrides" —
    // resolution falls back to the registry default.
    const config = getConfig();

    expect(config.llm.profiles["balanced-economy"]).toBeDefined();
    expect(config.llm.profileOrder).toContain("balanced-economy");
  });

  test("a profileOverrides entry for a flag-disabled built-in is retained on disk and re-applies on re-enable", () => {
    setOverridesForTesting({ [BALANCED_ECONOMY_FLAG]: false });
    writeConfig({
      llm: {
        profileOverrides: {
          "balanced-economy": { label: "My Economy", status: "disabled" },
        },
        activeProfile: "balanced",
      },
    });

    expect(getConfig().llm.profiles["balanced-economy"]).toBeUndefined();

    // The override store on disk is untouched while the flag is off.
    const onDisk = readConfigFromDisk() as {
      llm: { profileOverrides: Record<string, unknown> };
    };
    expect(onDisk.llm.profileOverrides["balanced-economy"]).toEqual({
      label: "My Economy",
      status: "disabled",
    });

    // Flag re-enables → the profile reappears with the override applied.
    setOverridesForTesting({ [BALANCED_ECONOMY_FLAG]: true });
    invalidateConfigCache();
    const config = getConfig();

    expect(config.llm.profiles["balanced-economy"]).toBeDefined();
    expect(config.llm.profiles["balanced-economy"]!.label).toBe("My Economy");
    expect(config.llm.profiles["balanced-economy"]!.status).toBe("disabled");
  });

  test("activeProfile naming a custom user profile is NOT reset", () => {
    writeConfig({
      llm: {
        profiles: {
          "my-custom": {
            provider: "anthropic",
            model: "claude-opus-4-8",
            source: "user",
          },
        },
        activeProfile: "my-custom",
      },
    });

    const config = getConfig();

    expect(config.llm.activeProfile).toBe("my-custom");
    expect(config.llm.profiles["my-custom"]!.model).toBe("claude-opus-4-8");
  });

  test("a pure read writes nothing back to config.json", () => {
    writeConfig({
      llm: {
        profiles: {
          balanced: {
            provider: "anthropic",
            model: "claude-drifted-model",
            label: "Renamed",
          },
          "my-custom": { provider: "anthropic", model: "claude-opus-4-8" },
        },
        activeProfile: "my-custom",
      },
    });
    const before = readFileSync(CONFIG_PATH, "utf-8");
    const mtimeBefore = statSync(CONFIG_PATH).mtimeMs;

    getConfig();

    expect(readFileSync(CONFIG_PATH, "utf-8")).toBe(before);
    expect(statSync(CONFIG_PATH).mtimeMs).toBe(mtimeBefore);
  });

  test("handleListProfiles (GET /v1/config/llm/profiles) sees built-ins via getConfig() with no route change", async () => {
    writeConfig({ llm: {} });

    const route = LLM_CALL_SITES_ROUTES.find(
      (r) => r.operationId === "llm_profiles_list",
    )!;
    expect(route).toBeDefined();

    const result = (await route.handler({} as RouteHandlerArgs)) as {
      profiles: string[];
      activeProfile: string | null;
    };

    for (const name of BUILTIN_NAMES) {
      expect(result.profiles).toContain(name);
    }
    expect(result.activeProfile).toBe("balanced");
  });
});
