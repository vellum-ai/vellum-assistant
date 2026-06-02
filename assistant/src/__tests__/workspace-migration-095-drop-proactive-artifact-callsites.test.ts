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

import { dropProactiveArtifactCallsitesMigration } from "../workspace/migrations/095-drop-proactive-artifact-callsites.js";

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-095-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workspaceDir, { recursive: true });
}

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
  freshWorkspace();
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe("095-drop-proactive-artifact-callsites migration", () => {
  test("has correct migration id and description", () => {
    expect(dropProactiveArtifactCallsitesMigration.id).toBe(
      "095-drop-proactive-artifact-callsites",
    );
    expect(dropProactiveArtifactCallsitesMigration.description).toBe(
      "Strip proactive artifact LLM call-site overrides from config.json (feature removed)",
    );
  });

  test("no-op when config.json does not exist", () => {
    dropProactiveArtifactCallsitesMigration.run(workspaceDir);
    expect(existsSync(join(workspaceDir, "config.json"))).toBe(false);
  });

  test("gracefully handles invalid JSON", () => {
    writeFileSync(join(workspaceDir, "config.json"), "not-valid-json");
    dropProactiveArtifactCallsitesMigration.run(workspaceDir);
    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      "not-valid-json",
    );
  });

  test("gracefully handles missing or non-object llm config", () => {
    const original = { llm: "custom", otherKey: true };
    writeConfig(original);
    dropProactiveArtifactCallsitesMigration.run(workspaceDir);
    expect(readConfig()).toEqual(original);
  });

  test("gracefully handles missing or non-object callSites config", () => {
    const original = { llm: { callSites: [] }, otherKey: true };
    writeConfig(original);
    dropProactiveArtifactCallsitesMigration.run(workspaceDir);
    expect(readConfig()).toEqual(original);
  });

  test("strips removed proactive artifact call sites and preserves other settings", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic", model: "claude-sonnet-4-6" },
        callSites: {
          mainAgent: { profile: "balanced" },
          proactiveArtifactDecision: { profile: "cost-optimized" },
          proactiveArtifactBuild: { profile: "balanced" },
          memoryRouter: { profile: "balanced" },
        },
      },
      otherKey: "preserved",
    });

    dropProactiveArtifactCallsitesMigration.run(workspaceDir);

    const config = readConfig();
    const llm = config.llm as {
      callSites: Record<string, unknown>;
      default: Record<string, unknown>;
    };
    expect(llm.callSites.proactiveArtifactDecision).toBeUndefined();
    expect(llm.callSites.proactiveArtifactBuild).toBeUndefined();
    expect(llm.callSites.mainAgent).toEqual({ profile: "balanced" });
    expect(llm.callSites.memoryRouter).toEqual({ profile: "balanced" });
    expect(llm.default).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
    expect(config.otherKey).toBe("preserved");
  });

  test("leaves an empty callSites object when only removed keys were present", () => {
    writeConfig({
      llm: {
        callSites: {
          proactiveArtifactDecision: { profile: "cost-optimized" },
          proactiveArtifactBuild: { profile: "balanced" },
        },
      },
    });

    dropProactiveArtifactCallsitesMigration.run(workspaceDir);

    const llm = readConfig().llm as { callSites: Record<string, unknown> };
    expect(llm.callSites).toEqual({});
  });

  test("idempotency: re-running after strip is a no-op", () => {
    writeConfig({
      llm: {
        callSites: {
          proactiveArtifactDecision: { profile: "cost-optimized" },
          mainAgent: { profile: "balanced" },
        },
      },
    });

    dropProactiveArtifactCallsitesMigration.run(workspaceDir);
    const afterFirst = readConfig();

    dropProactiveArtifactCallsitesMigration.run(workspaceDir);
    const afterSecond = readConfig();

    expect(afterSecond).toEqual(afterFirst);
  });

  test("idempotency: no-op on already-stripped config does not rewrite", () => {
    const original = {
      llm: { callSites: { mainAgent: { profile: "balanced" } } },
    };
    writeConfig(original);

    const beforeContent = readFileSync(
      join(workspaceDir, "config.json"),
      "utf-8",
    );
    dropProactiveArtifactCallsitesMigration.run(workspaceDir);
    const afterContent = readFileSync(
      join(workspaceDir, "config.json"),
      "utf-8",
    );

    expect(afterContent).toBe(beforeContent);
  });
});
