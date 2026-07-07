import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
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

const WORKSPACE_DIR = process.env.VELLUM_WORKSPACE_DIR!;
const CONFIG_PATH = join(WORKSPACE_DIR, "config.json");

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

mock.module("../../util/logger.js", () => ({
  getLogger: () => makeLoggerStub(),
}));

afterAll(() => {
  mock.restore();
});

import { setOverridesForTesting } from "../../__tests__/feature-flag-test-helpers.js";
import { getEffectiveProfile } from "../default-profile-catalog.js";
import { invalidateConfigCache } from "../loader.js";
import { LLMSchema } from "../schemas/llm.js";
import { seedInferenceProfiles } from "../seed-inference-profiles.js";
import { reconcileFlagGatedProfiles } from "../sync-gated-profiles.js";

type RawConfig = {
  llm: {
    profiles: Record<string, Record<string, unknown>>;
    profileOrder: string[];
    activeProfile?: string;
    advisorProfile?: string;
  };
};

function writeConfig(obj: unknown): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(obj, null, 2) + "\n");
}

function readConfig(): RawConfig {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
}

function seedBalancedConfig(): void {
  writeConfig({ llm: { default: { provider: "anthropic" } } });
  invalidateConfigCache();
  seedInferenceProfiles({});
}

describe("reconcileFlagGatedProfiles", () => {
  beforeEach(() => {
    ensureTestDir();
    if (existsSync(CONFIG_PATH)) rmSync(CONFIG_PATH, { force: true });
    delete process.env.IS_PLATFORM;
    setOverridesForTesting({});
    invalidateConfigCache();
  });

  afterEach(() => {
    delete process.env.IS_PLATFORM;
    setOverridesForTesting({});
    invalidateConfigCache();
  });

  test("flag on materializes the managed os-beta profile after balanced", () => {
    process.env.IS_PLATFORM = "true";
    seedBalancedConfig();
    setOverridesForTesting({ "os-beta": true });

    expect(reconcileFlagGatedProfiles()).toBe(true);

    const raw = readConfig();
    // On disk: a thin managed stub — profile content is code-owned.
    const osBeta = raw.llm.profiles["os-beta"]!;
    expect(osBeta).toEqual({ source: "managed" });

    // Through the effective view the stub resolves to the catalog body.
    const effective = getEffectiveProfile(raw.llm.profiles, "os-beta")!;
    expect(effective.model).toBe("MiniMaxAI/MiniMax-M3");
    expect(effective.provider_connection).toBe("vellum");
    expect(effective.provider).toBe("together");
    expect(effective.source).toBe("managed");
    expect(effective.label).toBe("OS Beta");
    expect(effective.effort).toBe("low");
    expect(effective.topP).toBe(0.95);

    const order = raw.llm.profileOrder;
    expect(order.indexOf("os-beta")).toBe(order.indexOf("balanced") + 1);
  });

  test("flag on in BYOK mode seeds the os-beta profile disabled", () => {
    seedBalancedConfig();
    setOverridesForTesting({ "os-beta": true });

    expect(reconcileFlagGatedProfiles()).toBe(true);

    const profiles = readConfig().llm.profiles;
    const osBeta = profiles["os-beta"]!;
    expect(osBeta.status).toBe("disabled");
    expect(osBeta.label).toBe("OS Beta (Managed)");
    expect(osBeta.source).toBe("managed");
    // Content stays code-owned; the effective view supplies it.
    expect(osBeta.effort).toBeUndefined();
    expect(getEffectiveProfile(profiles, "os-beta")?.effort).toBe("low");
  });

  test("flag on is idempotent across repeated runs", () => {
    process.env.IS_PLATFORM = "true";
    seedBalancedConfig();
    setOverridesForTesting({ "os-beta": true });

    expect(reconcileFlagGatedProfiles()).toBe(true);
    invalidateConfigCache();
    expect(reconcileFlagGatedProfiles()).toBe(false);
  });

  test("flag on preserves user overrides on the managed profile", () => {
    process.env.IS_PLATFORM = "true";
    seedBalancedConfig();
    setOverridesForTesting({ "os-beta": true });
    reconcileFlagGatedProfiles();

    const raw = readConfig();
    raw.llm.profiles["os-beta"]!.label = "My OS Beta";
    raw.llm.profiles["os-beta"]!.status = "disabled";
    raw.llm.profiles["os-beta"]!.topP = 0.8;
    writeConfig(raw);
    invalidateConfigCache();

    reconcileFlagGatedProfiles();

    const profiles = readConfig().llm.profiles;
    const after = profiles["os-beta"]!;
    expect(after.label).toBe("My OS Beta");
    expect(after.status).toBe("disabled");
    expect(after.topP).toBe(0.8);

    const effective = getEffectiveProfile(profiles, "os-beta")!;
    expect(effective.label).toBe("My OS Beta");
    expect(effective.topP).toBe(0.8);
    expect(effective.model).toBe("MiniMaxAI/MiniMax-M3");
    expect(effective.provider_connection).toBe("vellum");
    expect(effective.effort).toBe("low");
  });

  test("flag off removes a managed os-beta and applies fallbacks", () => {
    process.env.IS_PLATFORM = "true";
    seedBalancedConfig();
    setOverridesForTesting({ "os-beta": true });
    reconcileFlagGatedProfiles();

    const raw = readConfig();
    raw.llm.activeProfile = "os-beta";
    raw.llm.advisorProfile = "os-beta";
    writeConfig(raw);
    invalidateConfigCache();

    setOverridesForTesting({ "os-beta": false });
    expect(reconcileFlagGatedProfiles()).toBe(true);

    const after = readConfig();
    expect(after.llm.profiles["os-beta"]).toBeUndefined();
    expect(after.llm.profileOrder.includes("os-beta")).toBe(false);
    expect(after.llm.activeProfile).toBe("balanced");
    expect(after.llm.advisorProfile).toBe("quality-optimized");
  });

  test("flag off with no os-beta present is a no-op", () => {
    process.env.IS_PLATFORM = "true";
    seedBalancedConfig();
    setOverridesForTesting({ "os-beta": false });

    expect(reconcileFlagGatedProfiles()).toBe(false);
  });

  test("flag off scrubs os-beta from user mix arms, keeping >= 2-arm mixes", () => {
    process.env.IS_PLATFORM = "true";
    seedBalancedConfig();
    setOverridesForTesting({ "os-beta": true });
    reconcileFlagGatedProfiles();

    const raw = readConfig();
    raw.llm.profiles["my-mix"] = {
      source: "user",
      label: "My Mix",
      mix: [
        { profile: "balanced", weight: 70 },
        { profile: "quality-optimized", weight: 20 },
        { profile: "os-beta", weight: 30 },
      ],
    };
    raw.llm.profileOrder.push("my-mix");
    writeConfig(raw);
    invalidateConfigCache();

    setOverridesForTesting({ "os-beta": false });
    expect(reconcileFlagGatedProfiles()).toBe(true);

    const after = readConfig();
    expect(after.llm.profiles["os-beta"]).toBeUndefined();
    const mix = after.llm.profiles["my-mix"]!;
    expect(mix.mix).toEqual([
      { profile: "balanced", weight: 70 },
      { profile: "quality-optimized", weight: 20 },
    ]);
    expect(mix.source).toBe("user");
    expect(mix.label).toBe("My Mix");

    invalidateConfigCache();
    expect(reconcileFlagGatedProfiles()).toBe(false);
  });

  test("flag off removes a two-arm mix that loses os-beta and repoints refs", () => {
    process.env.IS_PLATFORM = "true";
    seedBalancedConfig();
    setOverridesForTesting({ "os-beta": true });
    reconcileFlagGatedProfiles();

    const raw = readConfig();
    raw.llm.profiles["experiment"] = {
      source: "user",
      label: "Experiment",
      mix: [
        { profile: "balanced", weight: 50 },
        { profile: "os-beta", weight: 50 },
      ],
    };
    raw.llm.profileOrder.push("experiment");
    raw.llm.activeProfile = "experiment";
    raw.llm.advisorProfile = "os-beta";
    (raw.llm as Record<string, unknown>).callSites = {
      mainAgent: { profile: "experiment" },
    };
    writeConfig(raw);
    invalidateConfigCache();

    setOverridesForTesting({ "os-beta": false });
    expect(reconcileFlagGatedProfiles()).toBe(true);

    const after = readConfig();
    expect(after.llm.profiles["os-beta"]).toBeUndefined();
    expect(after.llm.profiles["experiment"]).toBeUndefined();
    expect(after.llm.profileOrder.includes("os-beta")).toBe(false);
    expect(after.llm.profileOrder.includes("experiment")).toBe(false);
    expect(after.llm.activeProfile).toBe("balanced");
    expect(after.llm.advisorProfile).toBe("quality-optimized");
    expect(
      (
        after.llm as unknown as Record<
          string,
          Record<string, Record<string, unknown>>
        >
      ).callSites.mainAgent.profile,
    ).toBeUndefined();

    expect(LLMSchema.safeParse(after.llm).success).toBe(true);
  });

  test("flag off shortens a three-arm mix to two surviving arms", () => {
    process.env.IS_PLATFORM = "true";
    seedBalancedConfig();
    setOverridesForTesting({ "os-beta": true });
    reconcileFlagGatedProfiles();

    const raw = readConfig();
    raw.llm.profiles["blend"] = {
      source: "user",
      label: "Blend",
      mix: [
        { profile: "balanced", weight: 40 },
        { profile: "os-beta", weight: 30 },
        { profile: "quality-optimized", weight: 30 },
      ],
    };
    raw.llm.profileOrder.push("blend");
    writeConfig(raw);
    invalidateConfigCache();

    setOverridesForTesting({ "os-beta": false });
    expect(reconcileFlagGatedProfiles()).toBe(true);

    const after = readConfig();
    expect(after.llm.profiles["os-beta"]).toBeUndefined();
    expect(after.llm.profiles["blend"]!.mix).toEqual([
      { profile: "balanced", weight: 40 },
      { profile: "quality-optimized", weight: 30 },
    ]);

    expect(LLMSchema.safeParse(after.llm).success).toBe(true);
  });

  test("flag off clears a call-site profile reference to os-beta", () => {
    process.env.IS_PLATFORM = "true";
    seedBalancedConfig();
    setOverridesForTesting({ "os-beta": true });
    reconcileFlagGatedProfiles();

    const raw = readConfig();
    (raw.llm as Record<string, unknown>).callSites = {
      inference: { profile: "os-beta", temperature: 0.3 },
    };
    writeConfig(raw);
    invalidateConfigCache();

    setOverridesForTesting({ "os-beta": false });
    expect(reconcileFlagGatedProfiles()).toBe(true);

    const after = readConfig();
    const inference = (
      after.llm as unknown as Record<
        string,
        Record<string, Record<string, unknown>>
      >
    ).callSites.inference;
    expect(inference.profile).toBeUndefined();
    expect(inference.temperature).toBe(0.3);

    expect(LLMSchema.safeParse(after.llm).success).toBe(true);
  });

  test("a user-owned os-beta profile is never touched", () => {
    process.env.IS_PLATFORM = "true";
    writeConfig({
      llm: {
        default: { provider: "anthropic" },
        profiles: {
          "os-beta": {
            source: "user",
            label: "Mine",
            provider: "anthropic",
            model: "claude-x",
            provider_connection: "anthropic-personal",
          },
        },
        profileOrder: ["os-beta"],
      },
    });
    invalidateConfigCache();
    const before = readFileSync(CONFIG_PATH, "utf-8");

    setOverridesForTesting({ "os-beta": true });
    expect(reconcileFlagGatedProfiles()).toBe(false);
    expect(readFileSync(CONFIG_PATH, "utf-8")).toBe(before);

    setOverridesForTesting({ "os-beta": false });
    expect(reconcileFlagGatedProfiles()).toBe(false);
    expect(readFileSync(CONFIG_PATH, "utf-8")).toBe(before);
  });
});
