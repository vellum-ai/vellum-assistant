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

  test("label and status differences do not count as edits", () => {
    const config = uneditedByokConfig();
    const profileMap = (config.llm as Record<string, unknown>)
      .profiles as Record<string, Record<string, unknown>>;
    profileMap["custom-balanced"] = {
      ...profileMap["custom-balanced"],
      label: "Balanced (renamed)",
      status: "disabled",
    };
    writeConfig(config);

    ensureByokDefaultProfiles(workspaceDir);

    expect(profiles()["custom-balanced"]).toBeUndefined();
    expect(llm().activeProfile).toBe("balanced");
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

  test("no-op when the default provider is vellum", () => {
    const config = uneditedByokConfig();
    (config.llm as Record<string, unknown>).defaultProvider = {
      provider: "vellum",
    };
    writeConfig(config);
    const before = readFileSync(configPath(), "utf-8");

    ensureByokDefaultProfiles(workspaceDir);

    expect(readFileSync(configPath(), "utf-8")).toBe(before);
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

  test("a custom copy for a different provider is kept", () => {
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
});
