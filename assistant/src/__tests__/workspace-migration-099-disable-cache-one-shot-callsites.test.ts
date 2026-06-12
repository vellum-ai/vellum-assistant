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

import { disableCacheOneShotCallsitesMigration } from "../workspace/migrations/099-disable-cache-one-shot-callsites.js";

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-099-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
  delete process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH;
});

afterEach(() => {
  delete process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH;
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

type CallSites = Record<string, Record<string, unknown>>;

function callSites(config: Record<string, unknown>): CallSites {
  return (config.llm as { callSites: CallSites }).callSites;
}

describe("099-disable-cache-one-shot-callsites migration", () => {
  test("has correct migration id", () => {
    expect(disableCacheOneShotCallsitesMigration.id).toBe(
      "099-disable-cache-one-shot-callsites",
    );
  });

  test("adds disableCache to existing one-shot entries, preserving other keys", () => {
    writeConfig({
      llm: {
        callSites: {
          recall: { profile: "cost-optimized", maxTokens: 4096 },
          replySuggestion: { profile: "cost-optimized" },
        },
      },
    });

    disableCacheOneShotCallsitesMigration.run(workspaceDir);

    const sites = callSites(readConfig());
    expect(sites.recall).toEqual({
      profile: "cost-optimized",
      maxTokens: 4096,
      disableCache: true,
    });
    expect(sites.replySuggestion).toEqual({
      profile: "cost-optimized",
      disableCache: true,
    });
  });

  test("leaves an explicit disableCache value untouched (user opted back in)", () => {
    writeConfig({
      llm: {
        callSites: {
          recall: { profile: "cost-optimized", disableCache: false },
        },
      },
    });

    disableCacheOneShotCallsitesMigration.run(workspaceDir);

    expect(callSites(readConfig()).recall.disableCache).toBe(false);
  });

  test("does not create entries for call sites absent from disk", () => {
    writeConfig({
      llm: {
        callSites: {
          mainAgent: { profile: "balanced" },
        },
      },
    });

    disableCacheOneShotCallsitesMigration.run(workspaceDir);

    const sites = callSites(readConfig());
    expect(sites.recall).toBeUndefined();
    expect(sites.homeGreeting).toBeUndefined();
    expect(sites.mainAgent).toEqual({ profile: "balanced" });
  });

  test("is idempotent across repeated runs", () => {
    writeConfig({
      llm: {
        callSites: {
          conversationTitle: { profile: "cost-optimized" },
        },
      },
    });

    disableCacheOneShotCallsitesMigration.run(workspaceDir);
    const afterFirst = readConfig();
    disableCacheOneShotCallsitesMigration.run(workspaceDir);

    expect(readConfig()).toEqual(afterFirst);
  });

  test("no-ops when config.json is missing or has no callSites", () => {
    disableCacheOneShotCallsitesMigration.run(workspaceDir);
    expect(existsSync(join(workspaceDir, "config.json"))).toBe(false);

    writeConfig({ llm: {} });
    disableCacheOneShotCallsitesMigration.run(workspaceDir);
    expect(readConfig()).toEqual({ llm: {} });
  });
});
