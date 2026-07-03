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

import { removeAdvisorCallsiteOverrideMigration } from "../workspace/migrations/112-remove-advisor-callsite-override.js";

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

beforeEach(() => {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-111-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe("112-remove-advisor-callsite-override migration", () => {
  test("has correct migration id and description", () => {
    expect(removeAdvisorCallsiteOverrideMigration.id).toBe(
      "112-remove-advisor-callsite-override",
    );
    expect(removeAdvisorCallsiteOverrideMigration.description).toBe(
      "Remove the stale advisor entry from llm.callSites (advisor call site removed)",
    );
  });

  // ─── No-op cases ────────────────────────────────────────────────────────

  test("no-op when config.json does not exist", () => {
    removeAdvisorCallsiteOverrideMigration.run(workspaceDir);
    expect(existsSync(join(workspaceDir, "config.json"))).toBe(false);
  });

  test("gracefully handles invalid JSON", () => {
    writeFileSync(join(workspaceDir, "config.json"), "not-valid-json");
    removeAdvisorCallsiteOverrideMigration.run(workspaceDir);
    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      "not-valid-json",
    );
  });

  test("no-op when config has no llm.callSites", () => {
    const original = { llm: { default: { provider: "anthropic" } } };
    writeConfig(original);
    removeAdvisorCallsiteOverrideMigration.run(workspaceDir);
    expect(readConfig()).toEqual(original);
  });

  test("no-op when llm.callSites has no advisor key", () => {
    const original = {
      llm: {
        callSites: {
          mainAgent: { profile: "quality-optimized" },
          memoryRouter: { profile: "latency-optimized" },
        },
      },
    };
    writeConfig(original);
    removeAdvisorCallsiteOverrideMigration.run(workspaceDir);
    expect(readConfig()).toEqual(original);
  });

  test("gracefully handles non-object llm / callSites shapes", () => {
    const original = { llm: { callSites: 42 } };
    writeConfig(original);
    removeAdvisorCallsiteOverrideMigration.run(workspaceDir);
    expect(readConfig()).toEqual(original);
  });

  // ─── Removal ────────────────────────────────────────────────────────────

  test("removes advisor and prunes the now-empty callSites map", () => {
    writeConfig({
      llm: {
        callSites: {
          advisor: { profile: "quality-optimized" },
        },
        advisorProfile: "frontier",
      },
    });

    removeAdvisorCallsiteOverrideMigration.run(workspaceDir);

    const llm = readConfig().llm as Record<string, unknown>;
    expect("callSites" in llm).toBe(false);
    // The unrelated top-level advisor profile selection is untouched.
    expect(llm.advisorProfile).toBe("frontier");
  });

  test("removes advisor but preserves other callSites keys", () => {
    writeConfig({
      llm: {
        callSites: {
          advisor: { profile: "quality-optimized" },
          mainAgent: { profile: "opus" },
          memoryRouter: { profile: "latency-optimized" },
        },
      },
    });

    removeAdvisorCallsiteOverrideMigration.run(workspaceDir);

    const callSites = (readConfig().llm as Record<string, unknown>)
      .callSites as Record<string, unknown>;
    expect("advisor" in callSites).toBe(false);
    expect(callSites.mainAgent).toEqual({ profile: "opus" });
    expect(callSites.memoryRouter).toEqual({ profile: "latency-optimized" });
  });

  // ─── Idempotency ────────────────────────────────────────────────────────

  test("idempotency: re-running yields no further mutation", () => {
    writeConfig({
      llm: {
        callSites: {
          advisor: { profile: "quality-optimized" },
          mainAgent: { profile: "opus" },
        },
      },
    });

    removeAdvisorCallsiteOverrideMigration.run(workspaceDir);
    const afterFirst = readConfig();

    removeAdvisorCallsiteOverrideMigration.run(workspaceDir);
    const afterSecond = readConfig();

    expect(afterSecond).toEqual(afterFirst);
  });

  test("idempotency: writes nothing on a config without the advisor key", () => {
    writeConfig({
      llm: { callSites: { mainAgent: { profile: "opus" } } },
    });
    const beforeContent = readFileSync(
      join(workspaceDir, "config.json"),
      "utf-8",
    );

    removeAdvisorCallsiteOverrideMigration.run(workspaceDir);

    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      beforeContent,
    );
  });
});
