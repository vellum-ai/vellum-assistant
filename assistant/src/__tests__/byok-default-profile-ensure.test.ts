/**
 * Tests for `ensureByokDefaultProfiles` in
 * `workspace/byok-default-profile-ensure.ts`.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  materializeProfile,
  resolveDefaultProfileForProvider,
  USER_PROFILE_TEMPLATES,
} from "../config/default-profile-catalog.js";
import type { DefaultProfileProvider } from "../config/default-profile-names.js";
import type { ProfileEntry } from "../config/schemas/llm.js";
import { ensureByokDefaultProfiles } from "../workspace/byok-default-profile-ensure.js";
import { ensureCompleteCustomProfiles } from "../workspace/custom-profile-ensure.js";

let workspaceDir: string;
let originalIsPlatform: string | undefined;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-byok-default-profile-ensure-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workspaceDir, { recursive: true });
}

function configPath(): string {
  return join(workspaceDir, "config.json");
}

function writeConfig(data: Record<string, unknown>): void {
  writeFileSync(configPath(), JSON.stringify(data, null, 2) + "\n");
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath(), "utf-8"));
}

function llm(): Record<string, unknown> {
  return readConfig().llm as Record<string, unknown>;
}

function profiles(): Record<string, Record<string, unknown>> {
  return llm().profiles as Record<string, Record<string, unknown>>;
}

function hatchBody(
  key: "balanced" | "quality-optimized" | "cost-optimized",
  provider: DefaultProfileProvider,
): ProfileEntry {
  const template = USER_PROFILE_TEMPLATES[`custom-${key}`];
  if (template === undefined) {
    throw new Error(`No user profile template for custom-${key}`);
  }
  return materializeProfile(template, provider, `${provider}-personal`);
}

/**
 * A `custom-*` copy as the earliest hatch era wrote it (#29755, 2026-05-05):
 * managed source, a "(Custom Provider)" label suffix, and no
 * `provider_connection` stamp.
 */
function eraHatchBody(
  key: "balanced" | "quality-optimized" | "cost-optimized",
  provider: DefaultProfileProvider,
  model: string,
): Record<string, unknown> {
  const { provider_connection: _pc, ...body } = hatchBody(
    key,
    provider,
  ) as Record<string, unknown>;
  return {
    ...body,
    source: "managed",
    label: `${body.label} (Custom Provider)`,
    model,
  };
}

/** An unedited anthropic BYOK install as the hatch seeder laid it out. */
function uneditedByokConfig(): Record<string, unknown> {
  return {
    llm: {
      defaultProvider: { provider: "anthropic" },
      activeProfile: "custom-balanced",
      advisorProfile: "custom-quality-optimized",
      profileOrder: [
        "balanced",
        "quality-optimized",
        "cost-optimized",
        "custom-balanced",
        "custom-quality-optimized",
        "custom-cost-optimized",
      ],
      callSites: {
        subagentSpawn: { profile: "custom-cost-optimized" },
      },
      profiles: {
        balanced: {
          source: "managed",
          status: "disabled",
          label: "Balanced (Managed)",
        },
        "quality-optimized": {
          source: "managed",
          status: "disabled",
          label: "Quality (Managed)",
        },
        "cost-optimized": {
          source: "managed",
          status: "disabled",
          label: "Speed (Managed)",
        },
        "custom-balanced": hatchBody("balanced", "anthropic"),
        "custom-quality-optimized": hatchBody("quality-optimized", "anthropic"),
        "custom-cost-optimized": hatchBody("cost-optimized", "anthropic"),
        "my-mix": {
          source: "user",
          label: "My Mix",
          mix: [
            { profile: "custom-balanced", weight: 1 },
            { profile: "custom-quality-optimized", weight: 1 },
          ],
        },
      },
    },
  };
}

/** Asserts a second run leaves the config file byte-identical. */
function expectSecondRunNoop(): void {
  const first = readFileSync(configPath(), "utf-8");
  ensureByokDefaultProfiles(workspaceDir);
  expect(readFileSync(configPath(), "utf-8")).toBe(first);
}

beforeEach(() => {
  freshWorkspace();
  originalIsPlatform = process.env.IS_PLATFORM;
  delete process.env.IS_PLATFORM;
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
  if (originalIsPlatform === undefined) {
    delete process.env.IS_PLATFORM;
  } else {
    process.env.IS_PLATFORM = originalIsPlatform;
  }
});

describe("ensureByokDefaultProfiles", () => {
  test("converts an unedited install onto the code-defined defaults", () => {
    writeConfig(uneditedByokConfig());

    ensureByokDefaultProfiles(workspaceDir);

    expect(profiles().balanced).toBeUndefined();
    expect(profiles()["quality-optimized"]).toBeUndefined();
    expect(profiles()["cost-optimized"]).toBeUndefined();
    expect(profiles()["custom-balanced"]).toBeUndefined();
    expect(profiles()["custom-quality-optimized"]).toBeUndefined();
    expect(profiles()["custom-cost-optimized"]).toBeUndefined();

    expect(llm().activeProfile).toBe("balanced");
    expect(llm().advisorProfile).toBe("quality-optimized");
    expect(llm().profileOrder).toEqual([
      "balanced",
      "quality-optimized",
      "cost-optimized",
    ]);
    const callSites = llm().callSites as Record<
      string,
      Record<string, unknown>
    >;
    expect(callSites.subagentSpawn?.profile).toBe("cost-optimized");
    expect(profiles()["my-mix"]?.mix).toEqual([
      { profile: "balanced", weight: 1 },
      { profile: "quality-optimized", weight: 1 },
    ]);

    // With the stub gone, the default resolves active and code-defined from
    // the BYOK provider's catalog column.
    const resolved = resolveDefaultProfileForProvider(
      profiles() as Record<string, ProfileEntry>,
      "balanced",
      { provider: "anthropic" },
    );
    expect(resolved?.source).toBe("managed");
    expect(resolved?.status).toBeUndefined();
    expect(resolved?.provider).toBe("anthropic");
    expect(resolved?.provider_connection).toBe("anthropic-personal");
  });

  test("second run is a no-op with unchanged file bytes", () => {
    writeConfig(uneditedByokConfig());

    ensureByokDefaultProfiles(workspaceDir);
    const first = readFileSync(configPath(), "utf-8");
    ensureByokDefaultProfiles(workspaceDir);
    const second = readFileSync(configPath(), "utf-8");

    expect(second).toBe(first);
  });

  test("a user-edited custom copy survives untouched with its references", () => {
    const config = uneditedByokConfig();
    const llmConfig = config.llm as Record<string, unknown>;
    const profileMap = llmConfig.profiles as Record<
      string,
      Record<string, unknown>
    >;
    profileMap["custom-balanced"] = {
      ...profileMap["custom-balanced"],
      model: "claude-opus-4-6",
    };
    writeConfig(config);

    ensureByokDefaultProfiles(workspaceDir);

    expect(profiles()["custom-balanced"]).toEqual({
      ...hatchBody("balanced", "anthropic"),
      model: "claude-opus-4-6",
    });
    expect(llm().activeProfile).toBe("custom-balanced");
    expect(llm().profileOrder).toContain("custom-balanced");
    expect(profiles()["my-mix"]?.mix).toEqual([
      { profile: "custom-balanced", weight: 1 },
      { profile: "quality-optimized", weight: 1 },
    ]);

    expect(profiles()["custom-quality-optimized"]).toBeUndefined();
    expect(profiles()["custom-cost-optimized"]).toBeUndefined();
    expect(llm().advisorProfile).toBe("quality-optimized");
    const callSites = llm().callSites as Record<
      string,
      Record<string, unknown>
    >;
    expect(callSites.subagentSpawn?.profile).toBe("cost-optimized");
  });

  test("bodies baked by ensureCompleteCustomProfiles on a prior boot convert fully", () => {
    writeConfig(uneditedByokConfig());
    ensureCompleteCustomProfiles(workspaceDir);
    // Sanity: completion actually baked defaulted fields onto the copies.
    expect(profiles()["custom-balanced"]?.speed).toBe("standard");
    expect(
      (profiles()["custom-balanced"]?.contextWindow as Record<string, unknown>)
        .overflowRecovery,
    ).toBeDefined();

    ensureByokDefaultProfiles(workspaceDir);

    expect(profiles()["custom-balanced"]).toBeUndefined();
    expect(profiles()["custom-quality-optimized"]).toBeUndefined();
    expect(profiles()["custom-cost-optimized"]).toBeUndefined();
    expect(profiles().balanced).toBeUndefined();
    expect(llm().activeProfile).toBe("balanced");
    expect(llm().advisorProfile).toBe("quality-optimized");
    expectSecondRunNoop();
  });

  test.each([
    ["anthropic", "quality-optimized", "claude-opus-4-7"],
    ["anthropic", "quality-optimized", "claude-opus-4-8"],
    ["openrouter", "quality-optimized", "anthropic/claude-opus-4.8"],
    ["gemini", "cost-optimized", "gemini-3.1-flash-lite-preview"],
    ["openai", "cost-optimized", "gpt-5.4-nano"],
    ["openai", "balanced", "gpt-5.4-mini"],
    ["openai", "quality-optimized", "gpt-5.4"],
    ["fireworks", "balanced", "accounts/fireworks/models/kimi-k2p5"],
    ["fireworks", "balanced", "accounts/fireworks/models/kimi-k2p6"],
    [
      "fireworks",
      "quality-optimized",
      "accounts/fireworks/models/deepseek-v4-flash",
    ],
  ] as const)(
    "a historical intent-era copy converts (%s %s pinned to %s)",
    (provider, key, model) => {
      writeConfig({
        llm: {
          defaultProvider: { provider },
          activeProfile: `custom-${key}`,
          profiles: {
            [`custom-${key}`]: { ...hatchBody(key, provider), model },
          },
        },
      });

      ensureByokDefaultProfiles(workspaceDir);

      expect(profiles()[`custom-${key}`]).toBeUndefined();
      expect(llm().activeProfile).toBe(key);
      expectSecondRunNoop();
    },
  );

  test("the earliest-era copies (managed source, suffixed labels, no connection stamp) convert fully", () => {
    writeConfig({
      llm: {
        defaultProvider: { provider: "fireworks" },
        activeProfile: "custom-balanced",
        advisorProfile: "custom-quality-optimized",
        profiles: {
          "custom-balanced": eraHatchBody(
            "balanced",
            "fireworks",
            "accounts/fireworks/models/kimi-k2p5",
          ),
          "custom-quality-optimized": eraHatchBody(
            "quality-optimized",
            "fireworks",
            "accounts/fireworks/models/kimi-k2p5",
          ),
          "custom-cost-optimized": eraHatchBody(
            "cost-optimized",
            "fireworks",
            "accounts/fireworks/models/kimi-k2p5",
          ),
        },
      },
    });

    ensureByokDefaultProfiles(workspaceDir);

    expect(profiles()["custom-balanced"]).toBeUndefined();
    expect(profiles()["custom-quality-optimized"]).toBeUndefined();
    expect(profiles()["custom-cost-optimized"]).toBeUndefined();
    // The era label is hatch-written, not a rename: no overlay stub carries
    // it onto the bare keys.
    expect(profiles().balanced).toBeUndefined();
    expect(profiles()["quality-optimized"]).toBeUndefined();
    expect(profiles()["cost-optimized"]).toBeUndefined();
    expect(llm().activeProfile).toBe("balanced");
    expect(llm().advisorProfile).toBe("quality-optimized");
    expectSecondRunNoop();
  });

  test("an earliest-era copy with a user-edited model stays kept", () => {
    writeConfig({
      llm: {
        defaultProvider: { provider: "fireworks" },
        activeProfile: "custom-balanced",
        profiles: {
          "custom-balanced": eraHatchBody(
            "balanced",
            "fireworks",
            "accounts/fireworks/models/qwen-4-coder",
          ),
        },
      },
    });
    const before = readFileSync(configPath(), "utf-8");

    ensureByokDefaultProfiles(workspaceDir);

    expect(readFileSync(configPath(), "utf-8")).toBe(before);
  });

  test("a body without the conventional connection stamp converts", () => {
    // Migration 133 drops `<provider>-personal` from every entry.
    const { provider_connection: _pc, ...body } = hatchBody(
      "balanced",
      "anthropic",
    ) as Record<string, unknown>;
    writeConfig({
      llm: {
        defaultProvider: { provider: "anthropic" },
        activeProfile: "custom-balanced",
        profiles: { "custom-balanced": body },
      },
    });

    ensureByokDefaultProfiles(workspaceDir);

    expect(profiles()["custom-balanced"]).toBeUndefined();
    expect(llm().activeProfile).toBe("balanced");
    expectSecondRunNoop();
  });

  test("stubs carrying the migration-097 thinking stamp are deleted (real-world shape)", () => {
    const config = uneditedByokConfig();
    const profs = (config.llm as Record<string, unknown>).profiles as Record<
      string,
      Record<string, unknown>
    >;
    // Migration 097 / repairAdaptiveThinkingOnManagedProfiles stamp thinking
    // onto the anthropic-backed managed entries; live BYOK stubs carry it on
    // balanced and quality-optimized (confirmed on a real workspace).
    profs["balanced"].thinking = { enabled: true, streamThinking: true };
    profs["quality-optimized"].thinking = {
      enabled: true,
      streamThinking: true,
    };
    writeConfig(config);
    // Real installs booted with the completion pass baking the copies first.
    ensureCompleteCustomProfiles(workspaceDir);

    ensureByokDefaultProfiles(workspaceDir);

    const p = profiles();
    for (const name of [
      "balanced",
      "quality-optimized",
      "cost-optimized",
      "custom-balanced",
      "custom-quality-optimized",
      "custom-cost-optimized",
    ]) {
      expect(p[name]).toBeUndefined();
    }
    expect(llm().activeProfile).toBe("balanced");
    expect(llm().advisorProfile).toBe("quality-optimized");
    expectSecondRunNoop();
  });

  test("a stub with a non-repair thinking value survives and the advisor still lands on the dispatchable class", () => {
    const config = uneditedByokConfig();
    const profs = (config.llm as Record<string, unknown>).profiles as Record<
      string,
      Record<string, unknown>
    >;
    profs["quality-optimized"].thinking = {
      enabled: false,
      streamThinking: false,
    };
    writeConfig(config);

    ensureByokDefaultProfiles(workspaceDir);

    const p = profiles();
    expect(p["quality-optimized"]).toBeDefined();
    expect(p["custom-quality-optimized"]).toBeUndefined();
    // The surviving disabled stub still dispatches the catalog body, so the
    // advisor repair must not skip past quality to a lower class.
    expect(llm().advisorProfile).toBe("quality-optimized");
    expectSecondRunNoop();
  });

  test("a historical model pinned on the wrong key does not convert", () => {
    // claude-opus-4-7 was only ever the quality intent; on custom-balanced it
    // is a user edit.
    const config = uneditedByokConfig();
    const profileMap = (config.llm as Record<string, unknown>)
      .profiles as Record<string, Record<string, unknown>>;
    profileMap["custom-balanced"] = {
      ...profileMap["custom-balanced"],
      model: "claude-opus-4-7",
    };
    writeConfig(config);

    ensureByokDefaultProfiles(workspaceDir);

    expect(profiles()["custom-balanced"]).toBeDefined();
    expect(llm().activeProfile).toBe("custom-balanced");
  });

  test("a renamed copy converts and carries the label onto a thin stub", () => {
    const config = uneditedByokConfig();
    const profileMap = (config.llm as Record<string, unknown>)
      .profiles as Record<string, Record<string, unknown>>;
    profileMap["custom-balanced"] = {
      ...profileMap["custom-balanced"],
      label: "My Balanced",
    };
    writeConfig(config);

    ensureByokDefaultProfiles(workspaceDir);

    expect(profiles()["custom-balanced"]).toBeUndefined();
    expect(profiles().balanced).toEqual({
      source: "managed",
      label: "My Balanced",
    });
    expect(llm().activeProfile).toBe("balanced");
    const resolved = resolveDefaultProfileForProvider(
      profiles() as Record<string, ProfileEntry>,
      "balanced",
      { provider: "anthropic" },
    );
    expect(resolved?.label).toBe("My Balanced");
    expect(resolved?.provider).toBe("anthropic");
    expectSecondRunNoop();
  });

  test("a copy renamed exactly to the hatch-stub label converts with the label dropped", () => {
    const config = uneditedByokConfig();
    const profileMap = (config.llm as Record<string, unknown>)
      .profiles as Record<string, Record<string, unknown>>;
    profileMap["custom-balanced"] = {
      ...profileMap["custom-balanced"],
      label: "Balanced (Managed)",
    };
    writeConfig(config);

    ensureByokDefaultProfiles(workspaceDir);

    expect(profiles()["custom-balanced"]).toBeUndefined();
    // Carrying the label would reproduce the hatch-stub shape, so it is
    // dropped; with no other overlay state no stub is written.
    expect(profiles().balanced).toBeUndefined();
    expect(llm().activeProfile).toBe("balanced");
    expectSecondRunNoop();
    expectSecondRunNoop();
  });

  test("a copy renamed and disabled into the exact hatch-stub shape keeps the disable, drops the label", () => {
    const config = uneditedByokConfig();
    const profileMap = (config.llm as Record<string, unknown>)
      .profiles as Record<string, Record<string, unknown>>;
    profileMap["custom-balanced"] = {
      ...profileMap["custom-balanced"],
      label: "Balanced (Managed)",
      status: "disabled",
    };
    writeConfig(config);

    ensureByokDefaultProfiles(workspaceDir);

    expect(profiles()["custom-balanced"]).toBeUndefined();
    expect(profiles().balanced).toEqual({
      source: "managed",
      status: "disabled",
    });
    expectSecondRunNoop();
  });

  test("a re-enabled hatch stub is deleted", () => {
    // The bare key resolves active post-conversion, so deleting the
    // re-enabled stub preserves the enable.
    writeConfig({
      llm: {
        defaultProvider: { provider: "anthropic" },
        profiles: {
          "quality-optimized": {
            source: "managed",
            status: "active",
            label: "Quality (Managed)",
          },
        },
      },
    });

    ensureByokDefaultProfiles(workspaceDir);

    expect(profiles()["quality-optimized"]).toBeUndefined();
    expectSecondRunNoop();
  });

  test("a label-only hatch stub with no status key is deleted", () => {
    // Installs that predate #30367's status seeding got only the label
    // rewrite, and migration 126 thinned them to { source, label }.
    writeConfig({
      llm: {
        defaultProvider: { provider: "anthropic" },
        profiles: {
          balanced: { source: "managed", label: "Balanced (Managed)" },
          "cost-optimized": { source: "managed", label: "Speed (Managed)" },
        },
      },
    });

    ensureByokDefaultProfiles(workspaceDir);

    expect(profiles().balanced).toBeUndefined();
    expect(profiles()["cost-optimized"]).toBeUndefined();
    expectSecondRunNoop();
  });

  test("a user disable on the retired copy lands on the bare key past a label-only stub", () => {
    const config = uneditedByokConfig();
    const profileMap = (config.llm as Record<string, unknown>)
      .profiles as Record<string, Record<string, unknown>>;
    profileMap.balanced = { source: "managed", label: "Balanced (Managed)" };
    profileMap["custom-balanced"] = {
      ...profileMap["custom-balanced"],
      status: "disabled",
    };
    writeConfig(config);

    ensureByokDefaultProfiles(workspaceDir);

    expect(profiles()["custom-balanced"]).toBeUndefined();
    expect(profiles().balanced).toEqual({
      source: "managed",
      status: "disabled",
    });
    expectSecondRunNoop();
  });

  test("a disabled copy converts and carries the status onto a thin stub", () => {
    const config = uneditedByokConfig();
    const profileMap = (config.llm as Record<string, unknown>)
      .profiles as Record<string, Record<string, unknown>>;
    profileMap["custom-quality-optimized"] = {
      ...profileMap["custom-quality-optimized"],
      status: "disabled",
    };
    writeConfig(config);

    ensureByokDefaultProfiles(workspaceDir);

    expect(profiles()["custom-quality-optimized"]).toBeUndefined();
    expect(profiles()["quality-optimized"]).toEqual({
      source: "managed",
      status: "disabled",
    });
    // The advisor pointed at the now-disabled default, so the same write
    // repaired it to the strongest active one.
    expect(llm().advisorProfile).toBe("balanced");
    expectSecondRunNoop();
  });

  test("a hatch-identical label and absent status convert with no stub", () => {
    writeConfig(uneditedByokConfig());

    ensureByokDefaultProfiles(workspaceDir);

    expect(profiles().balanced).toBeUndefined();
    expect(profiles()["quality-optimized"]).toBeUndefined();
    expect(profiles()["cost-optimized"]).toBeUndefined();
  });

  test("an absent advisor profile is filled in the conversion write", () => {
    const config = uneditedByokConfig();
    delete (config.llm as Record<string, unknown>).advisorProfile;
    writeConfig(config);

    ensureByokDefaultProfiles(workspaceDir);

    expect(llm().advisorProfile).toBe("quality-optimized");
    expectSecondRunNoop();
  });

  test("an active profile naming a nonexistent profile is repointed at balanced", () => {
    const config = uneditedByokConfig();
    (config.llm as Record<string, unknown>).activeProfile = "ghost-profile";
    writeConfig(config);

    ensureByokDefaultProfiles(workspaceDir);

    expect(llm().activeProfile).toBe("balanced");
    expectSecondRunNoop();
  });

  test("the frozen pre-136 fireworks kimi body converts", () => {
    writeConfig({
      llm: {
        defaultProvider: { provider: "fireworks" },
        activeProfile: "custom-cost-optimized",
        profiles: {
          "custom-cost-optimized": {
            source: "user",
            label: "Speed",
            description: "Fastest responses at lower cost",
            maxTokens: 8192,
            effort: "low",
            thinking: { enabled: false, streamThinking: false },
            contextWindow: { maxInputTokens: 200000 },
            provider: "fireworks",
            provider_connection: "fireworks-personal",
            model: "accounts/fireworks/models/kimi-k2p5",
          },
        },
      },
    });

    ensureByokDefaultProfiles(workspaceDir);

    expect(profiles()["custom-cost-optimized"]).toBeUndefined();
    expect(llm().activeProfile).toBe("cost-optimized");
  });

  test("the pre-096 effort-max quality body converts", () => {
    writeConfig({
      llm: {
        defaultProvider: { provider: "anthropic" },
        advisorProfile: "custom-quality-optimized",
        profiles: {
          "custom-quality-optimized": {
            ...hatchBody("quality-optimized", "anthropic"),
            effort: "max",
          },
        },
      },
    });

    ensureByokDefaultProfiles(workspaceDir);

    expect(profiles()["custom-quality-optimized"]).toBeUndefined();
    expect(llm().advisorProfile).toBe("quality-optimized");
  });

  test("no-op on platform installs", () => {
    process.env.IS_PLATFORM = "true";
    writeConfig(uneditedByokConfig());
    const before = readFileSync(configPath(), "utf-8");

    ensureByokDefaultProfiles(workspaceDir);

    expect(readFileSync(configPath(), "utf-8")).toBe(before);
  });

  test("a vellum-default install (hatched BYOK, later platform-connected) converts fully", () => {
    const config = uneditedByokConfig();
    (config.llm as Record<string, unknown>).defaultProvider = {
      provider: "vellum",
    };
    writeConfig(config);

    ensureByokDefaultProfiles(workspaceDir);

    for (const name of [
      "balanced",
      "quality-optimized",
      "cost-optimized",
      "custom-balanced",
      "custom-quality-optimized",
      "custom-cost-optimized",
    ]) {
      expect(profiles()[name]).toBeUndefined();
    }
    expect(llm().activeProfile).toBe("balanced");
    expect(llm().advisorProfile).toBe("quality-optimized");
    // With the stub gone, the default resolves active from the vellum column.
    const resolved = resolveDefaultProfileForProvider(
      profiles() as Record<string, ProfileEntry>,
      "balanced",
      { provider: "vellum" },
    );
    expect(resolved?.source).toBe("managed");
    expect(resolved?.status).toBeUndefined();
    expectSecondRunNoop();
  });

  test("a vellum-default install keeps a user-edited copy untouched", () => {
    const config = uneditedByokConfig();
    const llmConfig = config.llm as Record<string, unknown>;
    llmConfig.defaultProvider = { provider: "vellum" };
    const profileMap = llmConfig.profiles as Record<
      string,
      Record<string, unknown>
    >;
    profileMap["custom-balanced"] = {
      ...profileMap["custom-balanced"],
      model: "claude-opus-4-6",
    };
    writeConfig(config);

    ensureByokDefaultProfiles(workspaceDir);

    expect(profiles()["custom-balanced"]).toEqual({
      ...hatchBody("balanced", "anthropic"),
      model: "claude-opus-4-6",
    });
    expect(llm().activeProfile).toBe("custom-balanced");
    expect(profiles()["custom-quality-optimized"]).toBeUndefined();
    expect(profiles()["custom-cost-optimized"]).toBeUndefined();
    expectSecondRunNoop();
  });

  test("no-op when llm.defaultProvider is absent or invalid", () => {
    const config = uneditedByokConfig();
    delete (config.llm as Record<string, unknown>).defaultProvider;
    writeConfig(config);
    const before = readFileSync(configPath(), "utf-8");
    ensureByokDefaultProfiles(workspaceDir);
    expect(readFileSync(configPath(), "utf-8")).toBe(before);

    (config.llm as Record<string, unknown>).defaultProvider = {
      provider: "not-a-provider",
    };
    writeConfig(config);
    const invalidBefore = readFileSync(configPath(), "utf-8");
    ensureByokDefaultProfiles(workspaceDir);
    expect(readFileSync(configPath(), "utf-8")).toBe(invalidBefore);
  });

  test("tolerates a missing or malformed config without throwing", () => {
    expect(() => ensureByokDefaultProfiles(workspaceDir)).not.toThrow();
    expect(existsSync(configPath())).toBe(false);

    writeFileSync(configPath(), "not valid json {{{");
    expect(() => ensureByokDefaultProfiles(workspaceDir)).not.toThrow();

    writeConfig({ llm: "not-an-object" });
    expect(() => ensureByokDefaultProfiles(workspaceDir)).not.toThrow();
  });

  test("a user-source shadow under a default key is left alone", () => {
    writeConfig({
      llm: {
        defaultProvider: { provider: "openai" },
        profiles: {
          balanced: {
            source: "user",
            provider: "openai",
            model: "gpt-5.4",
          },
        },
      },
    });
    const before = readFileSync(configPath(), "utf-8");

    ensureByokDefaultProfiles(workspaceDir);

    expect(readFileSync(configPath(), "utf-8")).toBe(before);
  });

  test("a real vellum-default workspace with re-enabled stubs and mixed connection stamps converts (specimen shape)", () => {
    // Mirrors a live 2026-07 workspace: hatched BYOK anthropic, later
    // platform-connected, stubs re-enabled through the UI, the
    // onboarding-authored copy stamped with the bare "anthropic" connection,
    // and call sites pinned at custom-balanced.
    writeConfig({
      llm: {
        defaultProvider: { provider: "vellum", connectionName: "vellum" },
        activeProfile: "balanced",
        advisorProfile: "quality-optimized",
        profileOrder: [
          "balanced",
          "os-beta",
          "quality-optimized",
          "cost-optimized",
          "custom-balanced",
          "custom-quality-optimized",
          "custom-cost-optimized",
        ],
        callSites: {
          subagentSpawn: { profile: "custom-balanced" },
          memoryRouter: {
            profile: "custom-balanced",
            contextWindow: { maxInputTokens: 1000000 },
          },
        },
        profiles: {
          balanced: {
            source: "managed",
            status: "active",
            label: "Balanced (Managed)",
            thinking: { enabled: true, streamThinking: true },
          },
          "quality-optimized": {
            source: "managed",
            status: "active",
            label: "Quality (Managed)",
            thinking: { enabled: true, streamThinking: true },
          },
          "cost-optimized": {
            source: "managed",
            status: "active",
            label: "Speed (Managed)",
          },
          "custom-balanced": {
            ...hatchBody("balanced", "anthropic"),
            provider_connection: "anthropic",
          },
          "custom-quality-optimized": hatchBody(
            "quality-optimized",
            "anthropic",
          ),
          "custom-cost-optimized": hatchBody("cost-optimized", "anthropic"),
          "os-beta": {
            source: "managed",
            status: "active",
            label: "OS Beta (Managed)",
          },
        },
      },
    });
    // The live workspace booted with completion baking the copies first.
    ensureCompleteCustomProfiles(workspaceDir);
    const osBetaBefore = { ...profiles()["os-beta"] };

    ensureByokDefaultProfiles(workspaceDir);

    for (const name of [
      "balanced",
      "quality-optimized",
      "cost-optimized",
      "custom-balanced",
      "custom-quality-optimized",
      "custom-cost-optimized",
    ]) {
      expect(profiles()[name]).toBeUndefined();
    }
    expect(profiles()["os-beta"]).toEqual(osBetaBefore);
    expect(llm().activeProfile).toBe("balanced");
    expect(llm().advisorProfile).toBe("quality-optimized");
    expect(llm().profileOrder).toEqual([
      "balanced",
      "os-beta",
      "quality-optimized",
      "cost-optimized",
    ]);
    const callSites = llm().callSites as Record<
      string,
      Record<string, unknown>
    >;
    expect(callSites.subagentSpawn?.profile).toBe("balanced");
    expect(callSites.memoryRouter?.profile).toBe("balanced");
    expect(callSites.memoryRouter?.contextWindow).toEqual({
      maxInputTokens: 1000000,
    });
    expectSecondRunNoop();
  });

  test("a managed-source default entry with body keys is left alone", () => {
    writeConfig({
      llm: {
        defaultProvider: { provider: "openai" },
        profiles: {
          balanced: {
            source: "managed",
            status: "disabled",
            label: "Balanced (Managed)",
            model: "gpt-5.4",
          },
        },
      },
    });
    const before = readFileSync(configPath(), "utf-8");

    ensureByokDefaultProfiles(workspaceDir);

    expect(readFileSync(configPath(), "utf-8")).toBe(before);
  });

  test("a custom copy for a different BYOK provider than the current default is kept", () => {
    // A re-provisioned copy is indistinguishable from a hatch copy for that
    // provider, so only copies matching the default provider convert.
    writeConfig({
      llm: {
        defaultProvider: { provider: "openai" },
        profiles: {
          "custom-balanced": hatchBody("balanced", "anthropic"),
        },
      },
    });
    const before = readFileSync(configPath(), "utf-8");

    ensureByokDefaultProfiles(workspaceDir);

    expect(readFileSync(configPath(), "utf-8")).toBe(before);
  });

  test("a vellum default keeps a singleton copy (incomplete set is not hatch provenance)", () => {
    // A lone surviving copy is trivially uniform; the complete-set
    // requirement keeps it.
    const config = uneditedByokConfig();
    const llmConfig = config.llm as Record<string, unknown>;
    llmConfig.defaultProvider = { provider: "vellum" };
    const profileMap = llmConfig.profiles as Record<
      string,
      Record<string, unknown>
    >;
    delete profileMap["custom-quality-optimized"];
    delete profileMap["custom-cost-optimized"];
    writeConfig(config);

    ensureByokDefaultProfiles(workspaceDir);

    expect(profiles()["custom-balanced"]).toBeDefined();
    expect(llm().activeProfile).toBe("custom-balanced");
    // The stubs are hatch residue regardless and still delete.
    expect(profiles().balanced).toBeUndefined();
    expectSecondRunNoop();
  });

  test("a vellum default keeps all copies when one was re-provisioned to another provider", () => {
    // A re-provisioned copy breaks provider uniformity and keeps the whole
    // set; the stubs still delete.
    const config = uneditedByokConfig();
    const llmConfig = config.llm as Record<string, unknown>;
    llmConfig.defaultProvider = { provider: "vellum" };
    const profileMap = llmConfig.profiles as Record<
      string,
      Record<string, unknown>
    >;
    profileMap["custom-balanced"] = hatchBody("balanced", "openai");
    writeConfig(config);

    ensureByokDefaultProfiles(workspaceDir);

    expect(profiles().balanced).toBeUndefined();
    expect(profiles()["quality-optimized"]).toBeUndefined();
    expect(profiles()["cost-optimized"]).toBeUndefined();
    expect(profiles()["custom-balanced"]).toBeDefined();
    expect(profiles()["custom-quality-optimized"]).toBeDefined();
    expect(profiles()["custom-cost-optimized"]).toBeDefined();
    expect(llm().activeProfile).toBe("custom-balanced");
    expectSecondRunNoop();
  });

  test("the pre-#39516 onboarding bare-provider connection stamp converts", () => {
    // Pre-#39516 web onboarding stamped the bare connection name.
    writeConfig({
      llm: {
        defaultProvider: { provider: "anthropic" },
        activeProfile: "custom-balanced",
        profiles: {
          "custom-balanced": {
            ...hatchBody("balanced", "anthropic"),
            provider_connection: "anthropic",
          },
        },
      },
    });

    ensureByokDefaultProfiles(workspaceDir);

    expect(profiles()["custom-balanced"]).toBeUndefined();
    expect(llm().activeProfile).toBe("balanced");
    expectSecondRunNoop();
  });

  test("a copy for an endpoint-supplied provider is kept even when body-identical to the template", () => {
    // Its connection can carry a base URL the bare key cannot recover.
    const body = hatchBody("balanced", "anthropic") as Record<string, unknown>;
    writeConfig({
      llm: {
        defaultProvider: { provider: "anthropic" },
        profiles: {
          "custom-balanced": {
            ...body,
            provider: "openai-compatible",
            provider_connection: "openai-compatible-personal",
          },
        },
      },
    });
    const before = readFileSync(configPath(), "utf-8");

    ensureByokDefaultProfiles(workspaceDir);

    expect(readFileSync(configPath(), "utf-8")).toBe(before);
  });

  test("a copy disable wins over a re-enabled hatch stub on the same key", () => {
    const config = uneditedByokConfig();
    const profileMap = (config.llm as Record<string, unknown>)
      .profiles as Record<string, Record<string, unknown>>;
    profileMap["quality-optimized"] = {
      source: "managed",
      status: "active",
      label: "Quality (Managed)",
    };
    profileMap["custom-quality-optimized"] = {
      ...profileMap["custom-quality-optimized"],
      status: "disabled",
    };
    writeConfig(config);

    ensureByokDefaultProfiles(workspaceDir);

    expect(profiles()["custom-quality-optimized"]).toBeUndefined();
    expect(profiles()["quality-optimized"]).toEqual({
      source: "managed",
      status: "disabled",
    });
    expectSecondRunNoop();
  });

  test("a copy pointing at a non-conventional connection is kept", () => {
    // A non-conventional reference could be an explicit selection among
    // several keys; retiring it could switch which key gets billed.
    writeConfig({
      llm: {
        defaultProvider: { provider: "anthropic" },
        profiles: {
          "custom-balanced": {
            ...hatchBody("balanced", "anthropic"),
            provider_connection: "anthropic-work",
          },
        },
      },
    });
    const before = readFileSync(configPath(), "utf-8");

    ensureByokDefaultProfiles(workspaceDir);

    expect(readFileSync(configPath(), "utf-8")).toBe(before);
  });

  // The hatch wrote each copy's model by resolving the cost profile's intent
  // at hatch time. These are the ids that resolved per provider, pinned as
  // literals rather than derived from the template: a test that materializes
  // the template agrees with itself no matter which intent the template names,
  // and so cannot catch a template whose model comparison has drifted off what
  // is on disk.
  test.each([
    ["openrouter", "anthropic/claude-haiku-4.5"],
    ["gemini", "gemini-3.1-flash-lite"],
    ["openai", "gpt-5.6-luna"],
  ] as const)(
    "an unedited %s cost copy still converts",
    (provider, hatchModel) => {
      writeConfig({
        llm: {
          defaultProvider: { provider },
          activeProfile: "custom-cost-optimized",
          profiles: {
            "custom-cost-optimized": {
              ...(hatchBody("cost-optimized", provider) as Record<
                string,
                unknown
              >),
              model: hatchModel,
            },
            "custom-balanced": hatchBody("balanced", provider),
            "custom-quality-optimized": hatchBody(
              "quality-optimized",
              provider,
            ),
          },
        },
      });

      ensureByokDefaultProfiles(workspaceDir);

      expect(profiles()["custom-cost-optimized"]).toBeUndefined();
      expect(profiles()["cost-optimized"]).toBeUndefined();
      expect(llm().activeProfile).toBe("cost-optimized");
      expectSecondRunNoop();
    },
  );
});
