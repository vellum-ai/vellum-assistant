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
  permissions: { mode: "strict" | "workspace" };
  skills: { load: { extraDirs: string[] } };
  sandbox: { enabled: boolean };
  [key: string]: unknown;
}

const testConfig: TestConfig = {
  permissions: { mode: "workspace" },
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

// ── Imports (after mocks) ─────────────────────────────────────────────────

import { check, generateAllowlistOptions } from "../permissions/checker.js";
import { clearRiskCache } from "../permissions/checker.js";
import { addRule, clearCache } from "../permissions/trust-store.js";
import { computeSkillVersionHash } from "../skills/version-hash.js";

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
    clearCache();
    testConfig.permissions = { mode: "workspace" };
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

  // ── Default prompt behavior ──────────────────────────────────────────

  describe("default prompt behavior", () => {
    test("dynamic skill prompts by default (matches skill_load_dynamic:* ask rule)", async () => {
      ensureSkillsDir();
      writeDynamicSkill("dynamic-prompt", "Dynamic Prompt Skill");

      const result = await check(
        "skill_load",
        { skill: "dynamic-prompt" },
        "/tmp",
      );
      expect(result.decision).toBe("prompt");
      expect(result.matchedRule).toBeDefined();
      expect(result.matchedRule!.pattern).toBe("skill_load_dynamic:*");
      expect(result.matchedRule!.decision).toBe("ask");
    });

    test("dynamic skill prompts in strict mode too", async () => {
      ensureSkillsDir();
      writeDynamicSkill("dynamic-strict", "Dynamic Strict Skill");
      testConfig.permissions.mode = "strict";

      const result = await check(
        "skill_load",
        { skill: "dynamic-strict" },
        "/tmp",
      );
      expect(result.decision).toBe("prompt");
      expect(result.matchedRule).toBeDefined();
      expect(result.matchedRule!.pattern).toBe("skill_load_dynamic:*");
    });
  });

  // ── Exact-hash allow rules ───────────────────────────────────────────

  describe("exact-hash allow rules", () => {
    test("exact skill_load_dynamic:<id>@<hash> rule auto-allows", async () => {
      ensureSkillsDir();
      writeDynamicSkill("dynamic-pinned", "Dynamic Pinned Skill");

      // Compute the transitive hash to create a version-pinned rule.
      const { computeTransitiveSkillVersionHash } =
        await import("../skills/transitive-version-hash.js");
      const { indexCatalogById } = await import("../skills/include-graph.js");
      const { loadSkillCatalog } = await import("../config/skills.js");

      const catalog = loadSkillCatalog();
      const index = indexCatalogById(catalog);
      const transitiveHash = computeTransitiveSkillVersionHash(
        "dynamic-pinned",
        index,
      );

      // Add an exact hash rule
      addRule(
        "skill_load",
        `skill_load_dynamic:dynamic-pinned@${transitiveHash}`,
        "everywhere",
        "allow",
        2000,
      );

      const result = await check(
        "skill_load",
        { skill: "dynamic-pinned" },
        "/tmp",
      );
      expect(result.decision).toBe("allow");
      expect(result.matchedRule).toBeDefined();
      expect(result.matchedRule!.pattern).toBe(
        `skill_load_dynamic:dynamic-pinned@${transitiveHash}`,
      );
    });
  });

  // ── Any-version allow rules ──────────────────────────────────────────

  describe("any-version allow rules", () => {
    test("skill_load_dynamic:<id> rule auto-allows any version", async () => {
      ensureSkillsDir();
      writeDynamicSkill("dynamic-anyver", "Dynamic Any Version Skill");

      addRule(
        "skill_load",
        "skill_load_dynamic:dynamic-anyver",
        "everywhere",
        "allow",
        2000,
      );

      const result = await check(
        "skill_load",
        { skill: "dynamic-anyver" },
        "/tmp",
      );
      expect(result.decision).toBe("allow");
      expect(result.matchedRule).toBeDefined();
      expect(result.matchedRule!.pattern).toBe(
        "skill_load_dynamic:dynamic-anyver",
      );
    });
  });

  // ── Changed transitive hash re-prompting ─────────────────────────────

  describe("changed transitive hash re-prompting", () => {
    test("editing a dynamic skill changes the hash, causing version-pinned rule to stop matching", async () => {
      ensureSkillsDir();
      writeDynamicSkill("dynamic-reprompt", "Dynamic Reprompt", "echo v1");

      const { computeTransitiveSkillVersionHash } =
        await import("../skills/transitive-version-hash.js");
      const { indexCatalogById } = await import("../skills/include-graph.js");
      const { loadSkillCatalog } = await import("../config/skills.js");

      const catalog1 = loadSkillCatalog();
      const index1 = indexCatalogById(catalog1);
      const hashV1 = computeTransitiveSkillVersionHash(
        "dynamic-reprompt",
        index1,
      );

      // Add a version-specific rule for v1
      addRule(
        "skill_load",
        `skill_load_dynamic:dynamic-reprompt@${hashV1}`,
        "everywhere",
        "allow",
        2000,
      );

      // v1: should auto-allow
      const resultV1 = await check(
        "skill_load",
        { skill: "dynamic-reprompt" },
        "/tmp",
      );
      expect(resultV1.decision).toBe("allow");
      expect(resultV1.matchedRule!.pattern).toBe(
        `skill_load_dynamic:dynamic-reprompt@${hashV1}`,
      );

      // Edit the skill (change the command)
      writeDynamicSkill("dynamic-reprompt", "Dynamic Reprompt", "echo v2");

      const catalog2 = loadSkillCatalog();
      const index2 = indexCatalogById(catalog2);
      const hashV2 = computeTransitiveSkillVersionHash(
        "dynamic-reprompt",
        index2,
      );
      expect(hashV2).not.toBe(hashV1);

      // v2: the version-specific rule no longer matches; falls through
      // to the default skill_load_dynamic:* ask rule
      const resultV2 = await check(
        "skill_load",
        { skill: "dynamic-reprompt" },
        "/tmp",
      );
      expect(resultV2.decision).toBe("prompt");
      expect(resultV2.matchedRule!.pattern).toBe("skill_load_dynamic:*");
    });
  });

  // ── Non-dynamic skills continue matching skill_load:* ────────────────

  describe("non-dynamic skills continue to use skill_load:* flow", () => {
    test("plain skill (no inline expansions) matches skill_load:* allow rule", async () => {
      ensureSkillsDir();
      writePlainSkill("plain-skill", "Plain Skill");

      const result = await check(
        "skill_load",
        { skill: "plain-skill" },
        "/tmp",
      );
      expect(result.decision).toBe("allow");
      expect(result.matchedRule).toBeDefined();
      expect(result.matchedRule!.pattern).toBe("skill_load:*");
    });

    test("plain skill with version-specific rule still uses skill_load: namespace", async () => {
      ensureSkillsDir();
      writePlainSkill("plain-pinned", "Plain Pinned Skill");
      testConfig.permissions.mode = "strict";

      const skillDir = join(testDir, "skills", "plain-pinned");
      const diskHash = computeSkillVersionHash(skillDir);

      addRule(
        "skill_load",
        `skill_load:plain-pinned@${diskHash}`,
        "everywhere",
        "allow",
        2000,
      );

      const result = await check(
        "skill_load",
        { skill: "plain-pinned" },
        "/tmp",
      );
      expect(result.decision).toBe("allow");
      expect(result.matchedRule!.pattern).toBe(
        `skill_load:plain-pinned@${diskHash}`,
      );
    });
  });

  // ── Feature flag disabled ────────────────────────────────────────────

  describe("feature flag disabled", () => {
    test("dynamic skill falls through to skill_load:* when flag is off", async () => {
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
      // With the flag off, the skill is treated as a normal skill_load
      expect(result.decision).toBe("allow");
      expect(result.matchedRule!.pattern).toBe("skill_load:*");
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

  // ── Default rule priority ────────────────────────────────────────────

  describe("default rule priority", () => {
    test("skill_load_dynamic:* ask rule has higher priority than skill_load:* allow rule", async () => {
      const { getDefaultRuleTemplates } =
        await import("../permissions/defaults.js");
      const rules = getDefaultRuleTemplates();

      const dynamicRule = rules.find(
        (r) => r.id === "default:ask-skill_load_dynamic-global",
      );
      const loadRule = rules.find(
        (r) => r.id === "default:allow-skill_load-global",
      );

      expect(dynamicRule).toBeDefined();
      expect(loadRule).toBeDefined();
      expect(dynamicRule!.priority).toBeGreaterThan(loadRule!.priority);
      expect(dynamicRule!.decision).toBe("ask");
      expect(dynamicRule!.pattern).toBe("skill_load_dynamic:*");
      expect(dynamicRule!.tool).toBe("skill_load");
    });
  });
});
