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

import { dropBalancedEconomyProfileMigration } from "../workspace/migrations/108-drop-balanced-economy-profile.js";

let workspaceDir: string;

function writeConfig(data: Record<string, unknown>): void {
  writeFileSync(
    join(workspaceDir, "config.json"),
    JSON.stringify(data, null, 2) + "\n",
  );
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(workspaceDir, "config.json"), "utf-8"));
}

function readLlm(): Record<string, unknown> {
  return readConfig().llm as Record<string, unknown>;
}

function readProfiles(): Record<string, Record<string, unknown>> {
  return readLlm().profiles as Record<string, Record<string, unknown>>;
}

const managedBalanced = {
  provider: "fireworks",
  provider_connection: "fireworks-managed",
  model: "accounts/fireworks/models/minimax-m3",
  source: "managed",
  label: "Balanced",
  description: "Good balance of quality, cost, and speed",
  maxTokens: 32000,
};

const managedEconomy = {
  provider: "fireworks",
  provider_connection: "fireworks-managed",
  model: "accounts/fireworks/models/minimax-m3",
  source: "managed",
  label: "Balanced Economy",
  description: "Strong open model (MiniMax M3) at a lower price point",
  maxTokens: 32000,
};

beforeEach(() => {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-107-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe("108-drop-balanced-economy-profile migration", () => {
  test("no-op when config.json does not exist", () => {
    dropBalancedEconomyProfileMigration.run(workspaceDir);
    expect(existsSync(join(workspaceDir, "config.json"))).toBe(false);
  });

  test("no-op when config has no llm", () => {
    const original = { something: "else" };
    writeConfig(original);
    dropBalancedEconomyProfileMigration.run(workspaceDir);
    expect(readConfig()).toEqual(original);
  });

  test("gracefully handles invalid JSON", () => {
    writeFileSync(join(workspaceDir, "config.json"), "not-valid-json");
    dropBalancedEconomyProfileMigration.run(workspaceDir);
    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      "not-valid-json",
    );
  });

  test("drops balanced-economy, prunes profileOrder, leaves balanced alone", () => {
    writeConfig({
      llm: {
        profiles: {
          balanced: { ...managedBalanced },
          "balanced-economy": { ...managedEconomy },
        },
        profileOrder: ["balanced", "balanced-economy"],
        activeProfile: "balanced",
      },
    });
    dropBalancedEconomyProfileMigration.run(workspaceDir);

    const profiles = readProfiles();
    expect("balanced-economy" in profiles).toBe(false);
    // The seeder owns balanced's content; the migration must not touch it.
    expect(profiles.balanced).toEqual(managedBalanced);
    expect(readLlm().profileOrder).toEqual(["balanced"]);
  });

  test("repoints activeProfile from balanced-economy to balanced", () => {
    writeConfig({
      llm: {
        profiles: {
          balanced: { ...managedBalanced },
          "balanced-economy": { ...managedEconomy },
        },
        activeProfile: "balanced-economy",
      },
    });
    dropBalancedEconomyProfileMigration.run(workspaceDir);
    expect(readLlm().activeProfile).toBe("balanced");
  });

  test("repoints advisorProfile from balanced-economy to balanced", () => {
    writeConfig({
      llm: {
        profiles: {
          balanced: { ...managedBalanced },
          "balanced-economy": { ...managedEconomy },
        },
        advisorProfile: "balanced-economy",
      },
    });
    dropBalancedEconomyProfileMigration.run(workspaceDir);
    expect(readLlm().advisorProfile).toBe("balanced");
  });

  test("re-enables a disabled balanced when it becomes the active selection", () => {
    // Supported state: user disabled the old balanced profile while actively
    // using balanced-economy. After consolidation the active selection lands
    // on balanced, which must be enabled or the user is left with no route.
    writeConfig({
      llm: {
        profiles: {
          balanced: { ...managedBalanced, status: "disabled" },
          "balanced-economy": { ...managedEconomy },
        },
        activeProfile: "balanced-economy",
      },
    });
    dropBalancedEconomyProfileMigration.run(workspaceDir);

    expect(readLlm().activeProfile).toBe("balanced");
    expect("status" in readProfiles().balanced!).toBe(false);
  });

  test("leaves a disabled balanced alone when it was not the active selection", () => {
    // The user deliberately disabled balanced while active on a different
    // profile — dropping balanced-economy must not silently re-enable it.
    writeConfig({
      llm: {
        profiles: {
          balanced: { ...managedBalanced, status: "disabled" },
          quality: { source: "managed", provider: "anthropic", status: "ok" },
          "balanced-economy": { ...managedEconomy },
        },
        activeProfile: "quality",
      },
    });
    dropBalancedEconomyProfileMigration.run(workspaceDir);

    expect(readLlm().activeProfile).toBe("quality");
    expect(readProfiles().balanced!.status).toBe("disabled");
  });

  test("repoints call-site profile overrides to balanced", () => {
    writeConfig({
      llm: {
        profiles: {
          balanced: { ...managedBalanced },
          "balanced-economy": { ...managedEconomy },
        },
        callSites: {
          memoryRouter: { profile: "balanced-economy" },
          replySuggestion: { profile: "cost-optimized" },
        },
        activeProfile: "balanced",
      },
    });
    dropBalancedEconomyProfileMigration.run(workspaceDir);

    const callSites = readLlm().callSites as Record<
      string,
      Record<string, unknown>
    >;
    expect(callSites.memoryRouter!.profile).toBe("balanced");
    expect(callSites.replySuggestion!.profile).toBe("cost-optimized");
  });

  test("repoints mix-profile arms to balanced", () => {
    writeConfig({
      llm: {
        profiles: {
          balanced: { ...managedBalanced },
          "balanced-economy": { ...managedEconomy },
          "my-mix": {
            source: "user",
            mix: [
              { profile: "balanced-economy", weight: 1 },
              { profile: "quality-optimized", weight: 1 },
            ],
          },
        },
        activeProfile: "my-mix",
      },
    });
    dropBalancedEconomyProfileMigration.run(workspaceDir);

    const mix = readProfiles()["my-mix"]!.mix as Array<Record<string, unknown>>;
    expect(mix[0]!.profile).toBe("balanced");
    expect(mix[1]!.profile).toBe("quality-optimized");
  });

  test("leaves a user-owned balanced-economy profile and its references untouched", () => {
    // The ownership guard covers references too: a user profile sharing the
    // name keeps its profileOrder slot, active selection, and call-site pins.
    const original = {
      llm: {
        profiles: {
          balanced: { ...managedBalanced },
          "balanced-economy": {
            provider: "fireworks",
            model: "accounts/fireworks/models/minimax-m3",
            source: "user",
          },
        },
        profileOrder: ["balanced", "balanced-economy"],
        callSites: { memoryRouter: { profile: "balanced-economy" } },
        activeProfile: "balanced-economy",
        advisorProfile: "balanced-economy",
      },
    };
    writeConfig(original);
    dropBalancedEconomyProfileMigration.run(workspaceDir);
    expect(readConfig()).toEqual(original);
  });

  test("prunes a dangling balanced-economy reference even when the profile is absent", () => {
    writeConfig({
      llm: {
        profiles: { balanced: { ...managedBalanced } },
        profileOrder: ["balanced", "balanced-economy"],
        callSites: { memoryRouter: { profile: "balanced-economy" } },
        activeProfile: "balanced-economy",
      },
    });
    dropBalancedEconomyProfileMigration.run(workspaceDir);

    const llm = readLlm();
    expect(llm.profileOrder).toEqual(["balanced"]);
    expect(llm.activeProfile).toBe("balanced");
    expect(
      (llm.callSites as Record<string, Record<string, unknown>>).memoryRouter!
        .profile,
    ).toBe("balanced");
  });

  test("idempotency: no-op once balanced-economy is gone (no writes)", () => {
    writeConfig({
      llm: {
        profiles: { balanced: { ...managedBalanced } },
        profileOrder: ["balanced"],
        activeProfile: "balanced",
      },
    });
    const beforeContent = readFileSync(
      join(workspaceDir, "config.json"),
      "utf-8",
    );
    dropBalancedEconomyProfileMigration.run(workspaceDir);
    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      beforeContent,
    );
  });
});
