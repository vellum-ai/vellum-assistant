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

import { repairDeprecatedCodexModelIdMigration } from "../workspace/migrations/143-repair-deprecated-codex-model-id.js";
import { WORKSPACE_MIGRATIONS } from "../workspace/migrations/registry.js";

const DEPRECATED = "gpt-5.3-codex";
const REPLACEMENT = "gpt-5.6-terra";

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-143-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe("143-repair-deprecated-codex-model-id migration", () => {
  test("has correct migration id and is registered", () => {
    expect(repairDeprecatedCodexModelIdMigration.id).toBe(
      "143-repair-deprecated-codex-model-id",
    );
    expect(
      WORKSPACE_MIGRATIONS.some(
        (m) => m.id === "143-repair-deprecated-codex-model-id",
      ),
    ).toBe(true);
  });

  test("repairs chatgpt fragments in default, call sites, and profiles", () => {
    writeConfig({
      llm: {
        default: { provider: "chatgpt", model: DEPRECATED },
        callSites: {
          recall: { provider: "chatgpt", model: DEPRECATED, maxTokens: 4096 },
          // A providerless call-site pin inherits the winning profile's
          // provider and connection at resolve time, so it is repaired too.
          heartbeatAgent: { model: DEPRECATED },
          vision: { provider: "openai-compatible", model: DEPRECATED },
          malformed: DEPRECATED,
        },
        profiles: {
          codex: { provider: "chatgpt", model: DEPRECATED, source: "user" },
        },
      },
    });

    repairDeprecatedCodexModelIdMigration.run(workspaceDir);

    const llm = readConfig().llm as Record<string, any>;
    expect(llm.default.model).toBe(REPLACEMENT);
    expect(llm.callSites.recall.model).toBe(REPLACEMENT);
    expect(llm.callSites.recall.maxTokens).toBe(4096);
    expect(llm.callSites.heartbeatAgent.model).toBe(REPLACEMENT);
    expect(llm.callSites.vision.model).toBe(DEPRECATED);
    expect(llm.profiles.codex.model).toBe(REPLACEMENT);
    expect(llm.profiles.codex.source).toBe("user");
  });

  test("leaves other providers and other models untouched", () => {
    const config = {
      llm: {
        profiles: {
          // The allowlist only gates the "chatgpt" routing identity; an
          // openai-compatible endpoint may legitimately serve this id. A
          // providerless profile completes against the code-owned base, not
          // the subscription, so it stays untouched too.
          byok: { provider: "openai-compatible", model: DEPRECATED },
          inherited: { model: DEPRECATED },
          current: { provider: "chatgpt", model: "gpt-5.6-luna" },
        },
      },
    };
    writeConfig(config);
    const before = readFileSync(join(workspaceDir, "config.json"), "utf-8");

    repairDeprecatedCodexModelIdMigration.run(workspaceDir);

    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      before,
    );
  });

  test("is idempotent and tolerates missing or malformed config", () => {
    expect(() =>
      repairDeprecatedCodexModelIdMigration.run(workspaceDir),
    ).not.toThrow();

    writeFileSync(join(workspaceDir, "config.json"), "not json {{{");
    expect(() =>
      repairDeprecatedCodexModelIdMigration.run(workspaceDir),
    ).not.toThrow();

    writeConfig({
      llm: { profiles: { codex: { provider: "chatgpt", model: DEPRECATED } } },
    });
    repairDeprecatedCodexModelIdMigration.run(workspaceDir);
    const once = readFileSync(join(workspaceDir, "config.json"), "utf-8");
    repairDeprecatedCodexModelIdMigration.run(workspaceDir);
    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(once);
  });
});
