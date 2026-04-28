/**
 * Tests for inline-command skill load permission handling.
 *
 * When a skill contains inline command expansions (!\`...\`) and the
 * inline-skill-commands flag is on, the permission
 * system must:
 *
 * 1. Emit skill_load_dynamic:<id>@<hash> / skill_load_dynamic:<id> candidates
 *    instead of skill_load:<id>@<hash> / skill_load:<id>.
 * 2. Match the default ask rule for skill_load_dynamic:* (prompting by default).
 * 3. Allow exact-hash rules to auto-allow pinned versions.
 * 4. Re-prompt when the transitive hash changes (skill edited).
 * 5. Continue matching the existing skill_load:* flow for non-dynamic skills.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { _setOverridesForTesting } from "../config/assistant-feature-flags.js";

// ── Mock setup (must be before any imports from the project) ──────────────

const testDir = process.env.VELLUM_WORKSPACE_DIR!;

// Point the file-based trust backend at the test temp dir.
process.env.GATEWAY_SECURITY_DIR = join(testDir, "protected");

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

interface TestConfig {
  skills: { load: { extraDirs: string[] } };
  sandbox: { enabled: boolean };
  [key: string]: unknown;
}

const testConfig: TestConfig = {
  skills: { load: { extraDirs: [] } },
  sandbox: { enabled: true },
};

mock.module("../config/loader.js", () => ({
  getConfig: () => testConfig,
  loadConfig: () => testConfig,
  invalidateConfigCache: () => {},
  saveConfig: () => {},
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
}));

import {
  installIpcMock,
  mockIpcResponse,
} from "./helpers/gateway-classify-mock.js";
installIpcMock();
mockIpcResponse("classify_risk", {
  risk: "low",
  reason: "skill_load",
  matchType: "unknown",
});
mockIpcResponse("get_global_thresholds", {
  interactive: "low",
  background: "medium",
  headless: "none",
});

// ── Imports (after mocks) ─────────────────────────────────────────────────

import { check, generateAllowlistOptions } from "../permissions/checker.js";
import { clearRiskCache } from "../permissions/checker.js";
import { _clearGlobalCacheForTesting } from "../permissions/gateway-threshold-reader.js";

// ── Helpers ───────────────────────────────────────────────────────────────

function ensureSkillsDir(): void {
  mkdirSync(join(testDir, "skills"), { recursive: true });
}

/** Write a plain skill (no inline command expansions). */
function writePlainSkill(
  skillId: string,
  name: string,
  description = "Test skill",
): void {
  const skillDir = join(testDir, "skills", skillId);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: "${name}"\ndescription: "${description}"\n---\n\nPlain skill body.\n`,
  );
}

/** Write a skill with inline command expansions. */
function writeDynamicSkill(
  skillId: string,
  name: string,
  command = "echo hello",
  description = "Dynamic test skill",
): void {
  const skillDir = join(testDir, "skills", skillId);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: "${name}"\ndescription: "${description}"\n---\n\nThis skill uses !\`${command}\` inline.\n`,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("inline-command skill_load permissions", () => {
  beforeEach(() => {
    clearRiskCache();
    _clearGlobalCacheForTesting();
    mockIpcResponse("get_global_thresholds", {
      interactive: "low",
      background: "medium",
      headless: "none",
    });
    testConfig.skills = { load: { extraDirs: [] } };
    _setOverridesForTesting({
      "inline-skill-commands": true,
    });
    try {
      rmSync(join(testDir, "protected", "trust.json"));
    } catch {
      /* may not exist */
    }
    try {
      rmSync(join(testDir, "skills"), { recursive: true, force: true });
    } catch {
      /* may not exist */
    }
  });

  // ── Default behavior ─────────────────────────────────────────────────

  describe("default behavior", () => {
    test("dynamic skill auto-allows in workspace mode (low risk threshold)", async () => {
      ensureSkillsDir();
      writeDynamicSkill("dynamic-prompt", "Dynamic Prompt Skill");

      const result = await check(
        "skill_load",
        { skill: "dynamic-prompt" },
        "/tmp",
      );
      expect(result.decision).toBe("allow");
    });

    test("dynamic skill prompts in strict mode (no matching rule)", async () => {
      ensureSkillsDir();
      writeDynamicSkill("dynamic-strict", "Dynamic Strict Skill");
      mockIpcResponse("get_global_thresholds", {
        interactive: "none",
        background: "none",
        headless: "none",
      });
      _clearGlobalCacheForTesting();

      const result = await check(
        "skill_load",
        { skill: "dynamic-strict" },
        "/tmp",
      );
      expect(result.decision).toBe("prompt");
      expect(result.reason).toContain("above auto-approve threshold");
    });
  });

  // ── Non-dynamic skills ───────────────────────────────────────────────

  describe("non-dynamic skills continue to use skill_load flow", () => {
    test("plain skill auto-allows in workspace mode (low risk threshold)", async () => {
      ensureSkillsDir();
      writePlainSkill("plain-skill", "Plain Skill");

      const result = await check(
        "skill_load",
        { skill: "plain-skill" },
        "/tmp",
      );
      expect(result.decision).toBe("allow");
    });

  });

  // ── Feature flag disabled ────────────────────────────────────────────

  describe("feature flag disabled", () => {
    test("dynamic skill auto-allows when flag is off (low risk threshold)", async () => {
      ensureSkillsDir();
      writeDynamicSkill("dynamic-flag-off", "Dynamic Flag Off Skill");

      // Disable the feature flag
      _setOverridesForTesting({
        "inline-skill-commands": false,
      });

      const result = await check(
        "skill_load",
        { skill: "dynamic-flag-off" },
        "/tmp",
      );
      expect(result.decision).toBe("allow");
    });
  });

  // ── Allowlist options ────────────────────────────────────────────────

  describe("allowlist options", () => {
    test("dynamic skill allowlist options use skill_load_dynamic: namespace", async () => {
      ensureSkillsDir();
      writeDynamicSkill("dynamic-opts", "Dynamic Opts Skill");

      const options = await generateAllowlistOptions("skill_load", {
        skill: "dynamic-opts",
      });

      expect(options.length).toBeGreaterThanOrEqual(1);
      // All options should use skill_load_dynamic: prefix
      for (const option of options) {
        expect(option.pattern).toMatch(/^skill_load_dynamic:/);
      }

      // Should have an any-version option
      const anyVersionOption = options.find(
        (o) => o.pattern === "skill_load_dynamic:dynamic-opts",
      );
      expect(anyVersionOption).toBeDefined();
      expect(anyVersionOption!.description).toBe("This skill (any version)");
    });

    test("plain skill allowlist options use skill_load: namespace", async () => {
      ensureSkillsDir();
      writePlainSkill("plain-opts", "Plain Opts Skill");

      const options = await generateAllowlistOptions("skill_load", {
        skill: "plain-opts",
      });

      expect(options.length).toBeGreaterThanOrEqual(1);
      // Should use skill_load: prefix, not skill_load_dynamic:
      for (const option of options) {
        expect(option.pattern).toMatch(/^skill_load:/);
        expect(option.pattern).not.toMatch(/^skill_load_dynamic:/);
      }
    });
  });

});
