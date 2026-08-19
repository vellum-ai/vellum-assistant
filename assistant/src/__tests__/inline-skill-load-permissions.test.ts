/**
 * Tests for inline-command skill load permission handling.
 *
 * When a skill contains inline command expansions (!\`...\`), the permission
 * system must:
 *
 * 1. Emit skill_load_dynamic:<id>@<hash> / skill_load_dynamic:<id> candidates
 *    instead of skill_load:<id>@<hash> / skill_load:<id>.
 * 2. Classify the load as High risk so the auto-approve threshold governs it
 *    like any other high-risk action: it prompts below Full access and runs at
 *    Full access — unless a user trust rule covers it (gateway matchType
 *    "user_rule" lowers the risk, restoring the escape hatch).
 * 3. Continue matching the existing skill_load:* flow for non-dynamic skills.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// ── Mock setup (must be before any imports from the project) ──────────────

const testDir = process.env.VELLUM_WORKSPACE_DIR!;

// Point the file-based trust backend at the test temp dir.
process.env.GATEWAY_SECURITY_DIR = join(testDir, "protected");

import {
  installIpcMock,
  lastIpcParams,
  mockIpcResponse,
} from "./helpers/gateway-classify-mock.js";
installIpcMock();
mockIpcResponse("classify_risk", {
  risk: "low",
  reason: "skill_load",
  matchType: "unknown",
  scopeOptions: [],
});
mockIpcResponse("get_global_thresholds", {
  interactive: "low",
  autonomous: "medium",
  headless: "none",
});

// ── Imports (after mocks) ─────────────────────────────────────────────────

import { check, classifyRisk } from "../permissions/checker.js";
import { _clearGlobalCacheForTesting } from "../permissions/gateway-threshold-reader.js";
import { setOverridesForTesting } from "./feature-flag-test-helpers.js";

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

/**
 * What the gateway skill classifier answers for a load whose params carry
 * `hasInlineExpansions` (gateway/src/risk/skill-risk-classifier.ts): High,
 * registry-matched. The daemon does not elevate locally; the gateway is the
 * one place a dynamic load becomes High.
 */
function mockDynamicSkillClassification(): void {
  mockIpcResponse("classify_risk", {
    risk: "high",
    reason:
      "Skill load with inline command expansions (executes shell commands at load time)",
    matchType: "registry",
    scopeOptions: [],
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("inline-command skill_load permissions", () => {
  beforeEach(() => {
    _clearGlobalCacheForTesting();
    setOverridesForTesting({});
    mockIpcResponse("classify_risk", {
      risk: "low",
      reason: "skill_load",
      matchType: "unknown",
      scopeOptions: [],
    });
    mockIpcResponse("get_global_thresholds", {
      interactive: "low",
      autonomous: "medium",
      headless: "none",
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

  afterEach(() => {
    setOverridesForTesting({});
  });

  // ── Default behavior ─────────────────────────────────────────────────

  describe("threshold-governed prompting", () => {
    test("an uncovered dynamic skill prompts below Full access", async () => {
      ensureSkillsDir();
      writeDynamicSkill("dynamic-prompt", "Dynamic Prompt Skill");
      mockDynamicSkillClassification();

      // interactive threshold "low" (beforeEach) is below the High risk of an
      // inline-command load, so it prompts.
      const result = await check(
        "skill_load",
        { skill: "dynamic-prompt" },
        "/tmp",
      );
      expect(result.decision).toBe("prompt");
      expect(result.reason).toContain("above auto-approve threshold");
    });

    test("an uncovered dynamic skill runs at Full access (high threshold)", async () => {
      ensureSkillsDir();
      writeDynamicSkill("dynamic-full", "Dynamic Full Access Skill");
      mockDynamicSkillClassification();
      mockIpcResponse("get_global_thresholds", {
        interactive: "high",
        autonomous: "high",
        headless: "high",
      });
      _clearGlobalCacheForTesting();

      // Full access auto-approves High-risk actions — inline-command skill
      // loads included. No special-case override forces a prompt.
      const result = await check(
        "skill_load",
        { skill: "dynamic-full" },
        "/tmp",
      );
      expect(result.decision).toBe("allow");
    });

    test("a dynamic skill covered by a user trust rule is allowed", async () => {
      ensureSkillsDir();
      writeDynamicSkill("dynamic-covered", "Dynamic Covered Skill");
      mockIpcResponse("classify_risk", {
        risk: "low",
        reason: "user rule: skill_load_dynamic:dynamic-covered",
        matchType: "user_rule",
        scopeOptions: [],
      });

      const result = await check(
        "skill_load",
        { skill: "dynamic-covered" },
        "/tmp",
      );
      expect(result.decision).toBe("allow");
    });

    test("dynamic skill prompts in strict mode (no matching rule)", async () => {
      ensureSkillsDir();
      writeDynamicSkill("dynamic-strict", "Dynamic Strict Skill");
      mockDynamicSkillClassification();
      mockIpcResponse("get_global_thresholds", {
        interactive: "none",
        autonomous: "none",
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

  // ── Allowlist options ────────────────────────────────────────────────

  describe("skill metadata sent to the gateway", () => {
    // The gateway picks the `skill_load_dynamic:` namespace off these flags,
    // so what the daemon reads from disk decides which rule namespace a user
    // can save into.
    test("a skill with inline expansions is sent as dynamic", async () => {
      ensureSkillsDir();
      writeDynamicSkill("dynamic-opts", "Dynamic Opts Skill");

      await classifyRisk("skill_load", { skill: "dynamic-opts" });

      const metadata = lastIpcParams("classify_risk")?.skillMetadata as
        | { hasInlineExpansions: boolean; isDynamic: boolean }
        | undefined;
      expect(metadata?.hasInlineExpansions).toBe(true);
      expect(metadata?.isDynamic).toBe(true);
    });

    test("a plain skill is not sent as dynamic", async () => {
      ensureSkillsDir();
      writePlainSkill("plain-opts", "Plain Opts Skill");

      await classifyRisk("skill_load", { skill: "plain-opts" });

      const metadata = lastIpcParams("classify_risk")?.skillMetadata as
        | { hasInlineExpansions: boolean; isDynamic: boolean }
        | undefined;
      expect(metadata?.hasInlineExpansions).toBe(false);
      expect(metadata?.isDynamic).toBe(false);
    });
  });
});
