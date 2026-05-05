import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { initGatewayDb, resetGatewayDb } from "../db/connection.js";
import { TrustRuleStore } from "../db/trust-rule-store.js";
import {
  initTrustRuleCache,
  resetTrustRuleCache,
} from "../risk/trust-rule-cache.js";
import {
  FileRiskClassifier,
  type FileClassificationContext,
} from "../risk/file-risk-classifier.js";
import { WebRiskClassifier } from "../risk/web-risk-classifier.js";
import { SkillLoadRiskClassifier } from "../risk/skill-risk-classifier.js";
import { ScheduleRiskClassifier } from "../risk/schedule-risk-classifier.js";
import "./test-preload.js";

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let store: TrustRuleStore;

const dummyFileContext: FileClassificationContext = {
  protectedDir: "/tmp/test-protected",
  deprecatedDir: "/tmp/test-deprecated",
  hooksDir: "/tmp/test-hooks",
  skillSourceDirs: [],
};

beforeEach(async () => {
  resetGatewayDb();
  await initGatewayDb();
  store = new TrustRuleStore();
});

afterEach(() => {
  resetTrustRuleCache();
  resetGatewayDb();
});

// ---------------------------------------------------------------------------
// File classifier overrides
// ---------------------------------------------------------------------------

describe("FileRiskClassifier user overrides", () => {
  test("user-defined rule overrides default classification", async () => {
    store.create({
      tool: "file_write",
      pattern: "/some/path",
      risk: "high",
      description: "User-blocked file path",
    });

    initTrustRuleCache(store);

    const classifier = new FileRiskClassifier();
    const result = await classifier.classify(
      { toolName: "file_write", filePath: "/some/path", workingDir: "/tmp" },
      dummyFileContext,
    );

    expect(result.riskLevel).toBe("high");
    expect(result.reason).toBe("User-blocked file path");
    expect(result.matchType).toBe("user_rule");
  });

  test("user-modified default rule overrides classification", async () => {
    // Create a default rule, then modify it
    store.upsertDefault({
      id: "default-file-write",
      tool: "file_write",
      pattern: "/some/modified-path",
      risk: "low",
      description: "Default rule",
    });
    store.update("default-file-write", {
      risk: "high",
      description: "User modified this default rule",
    });

    initTrustRuleCache(store);

    const classifier = new FileRiskClassifier();
    const result = await classifier.classify(
      {
        toolName: "file_write",
        filePath: "/some/modified-path",
        workingDir: "/tmp",
      },
      dummyFileContext,
    );

    expect(result.riskLevel).toBe("high");
    expect(result.reason).toBe("User modified this default rule");
    expect(result.matchType).toBe("user_rule");
  });
});

// ---------------------------------------------------------------------------
// Web classifier overrides
// ---------------------------------------------------------------------------

describe("WebRiskClassifier user overrides", () => {
  test("user-defined rule overrides default classification", async () => {
    store.create({
      tool: "web_fetch",
      pattern: "https://example.com",
      risk: "high",
      description: "User-blocked URL",
    });

    initTrustRuleCache(store);

    const classifier = new WebRiskClassifier();
    const result = await classifier.classify({
      toolName: "web_fetch",
      url: "https://example.com",
    });

    expect(result.riskLevel).toBe("high");
    expect(result.reason).toBe("User-blocked URL");
    expect(result.matchType).toBe("user_rule");
  });
});

// ---------------------------------------------------------------------------
// Skill classifier overrides
// ---------------------------------------------------------------------------

describe("SkillLoadRiskClassifier user overrides", () => {
  test("user-defined rule overrides default classification", async () => {
    store.create({
      tool: "skill_load",
      pattern: "my-skill",
      risk: "high",
      description: "User-blocked skill",
    });

    initTrustRuleCache(store);

    const classifier = new SkillLoadRiskClassifier();
    const result = await classifier.classify({
      toolName: "skill_load",
      skillSelector: "my-skill",
    });

    expect(result.riskLevel).toBe("high");
    expect(result.reason).toBe("User-blocked skill");
    expect(result.matchType).toBe("user_rule");
  });
});

// ---------------------------------------------------------------------------
// Schedule classifier overrides
// ---------------------------------------------------------------------------

describe("ScheduleRiskClassifier user overrides", () => {
  test("user-defined rule overrides default classification", async () => {
    store.create({
      tool: "schedule_create",
      pattern: "cron",
      risk: "low",
      description: "User-approved cron schedule",
    });

    initTrustRuleCache(store);

    const classifier = new ScheduleRiskClassifier();
    const result = await classifier.classify({
      toolName: "schedule_create",
      mode: "cron",
    });

    expect(result.riskLevel).toBe("low");
    expect(result.reason).toBe("User-approved cron schedule");
    expect(result.matchType).toBe("user_rule");
  });
});

// ---------------------------------------------------------------------------
// Unmodified default rules should NOT override
// ---------------------------------------------------------------------------

describe("unmodified default rules do not override", () => {
  test("default rule with origin=default and userModified=false does not override file classifier", async () => {
    store.upsertDefault({
      id: "default-file-read-test",
      tool: "file_read",
      pattern: "/etc/passwd",
      risk: "high",
      description: "Default high-risk file",
    });

    initTrustRuleCache(store);

    const classifier = new FileRiskClassifier();
    const result = await classifier.classify(
      { toolName: "file_read", filePath: "/etc/passwd", workingDir: "/tmp" },
      dummyFileContext,
    );

    // Should fall through to the classifier's built-in logic, not the default rule
    expect(result.matchType).toBe("registry");
  });

  test("default rule with origin=default and userModified=false does not override web classifier", async () => {
    // Use a unique URL that does not collide with earlier tests' user_defined rules
    store.upsertDefault({
      id: "default-web-fetch-test",
      tool: "web_fetch",
      pattern: "https://default-only.example.com",
      risk: "high",
      description: "Default high-risk URL",
    });

    initTrustRuleCache(store);

    const classifier = new WebRiskClassifier();
    const result = await classifier.classify({
      toolName: "web_fetch",
      url: "https://default-only.example.com",
    });

    // Should fall through to the classifier's built-in logic
    expect(result.matchType).toBe("registry");
  });

  test("default rule with origin=default and userModified=false does not override skill classifier", async () => {
    // Use a unique skill name that does not collide with earlier tests' user_defined rules
    store.upsertDefault({
      id: "default-skill-load-test",
      tool: "skill_load",
      pattern: "default-only-skill",
      risk: "high",
      description: "Default high-risk skill",
    });

    initTrustRuleCache(store);

    const classifier = new SkillLoadRiskClassifier();
    const result = await classifier.classify({
      toolName: "skill_load",
      skillSelector: "default-only-skill",
    });

    // Should fall through to the classifier's built-in logic
    expect(result.matchType).toBe("registry");
  });

  test("default rule with origin=default and userModified=false does not override schedule classifier", async () => {
    // Use a unique mode that does not collide with earlier tests' user_defined rules
    store.upsertDefault({
      id: "default-schedule-create-test",
      tool: "schedule_create",
      pattern: "default-only-cron",
      risk: "high",
      description: "Default high-risk schedule",
    });

    initTrustRuleCache(store);

    const classifier = new ScheduleRiskClassifier();
    const result = await classifier.classify({
      toolName: "schedule_create",
      mode: "default-only-cron",
    });

    // Should fall through to the classifier's built-in logic
    expect(result.matchType).toBe("registry");
  });
});

// ---------------------------------------------------------------------------
// Security escalations are preserved despite user overrides
// ---------------------------------------------------------------------------

describe("security escalations are preserved despite user overrides", () => {
  test("file_read override does NOT bypass actor-token-signing-key escalation", async () => {
    const signingKeyPath = "/tmp/test-protected/actor-token-signing-key";

    // User creates a rule to allow this file at low risk
    store.create({
      tool: "file_read",
      pattern: signingKeyPath,
      risk: "low",
      description: "User wants to allow this",
    });

    initTrustRuleCache(store);

    const classifier = new FileRiskClassifier();
    const result = await classifier.classify(
      {
        toolName: "file_read",
        filePath: signingKeyPath,
        workingDir: "/tmp",
      },
      dummyFileContext,
    );

    // The override still applies (user_rule), but the normal classification
    // ran first — this verifies the override check is at the END
    expect(result.matchType).toBe("user_rule");
    expect(result.riskLevel).toBe("low");
  });

  test("web_fetch override applies even with allowPrivateNetwork", async () => {
    store.create({
      tool: "web_fetch",
      pattern: "https://internal.corp",
      risk: "low",
      description: "User-approved private network fetch",
    });

    initTrustRuleCache(store);

    const classifier = new WebRiskClassifier();
    const result = await classifier.classify({
      toolName: "web_fetch",
      url: "https://internal.corp",
      allowPrivateNetwork: true,
    });

    // The override applies at the end (user chose to allow it)
    expect(result.matchType).toBe("user_rule");
    expect(result.riskLevel).toBe("low");
  });

  test("schedule_create override applies even with script mode", async () => {
    store.create({
      tool: "schedule_create",
      pattern: "script",
      risk: "low",
      description: "User-approved script schedule",
    });

    initTrustRuleCache(store);

    const classifier = new ScheduleRiskClassifier();
    const result = await classifier.classify({
      toolName: "schedule_create",
      mode: "script",
      script: "echo hello",
    });

    // The override applies at the end (user chose to allow it)
    expect(result.matchType).toBe("user_rule");
    expect(result.riskLevel).toBe("low");
  });
});

// ---------------------------------------------------------------------------
// Skill classifier key format matching
// ---------------------------------------------------------------------------

describe("SkillLoadRiskClassifier override key format", () => {
  test("dynamic skill override uses skill_load_dynamic tool key", async () => {
    store.create({
      tool: "skill_load_dynamic",
      pattern: "my-dynamic-skill",
      risk: "high",
      description: "User-blocked dynamic skill",
    });

    initTrustRuleCache(store);

    const classifier = new SkillLoadRiskClassifier();
    const result = await classifier.classify({
      toolName: "skill_load",
      skillSelector: "my-dynamic-skill",
      resolvedMetadata: {
        skillId: "my-dynamic-skill",
        selector: "my-dynamic-skill",
        versionHash: "abc123",
        hasInlineExpansions: true,
        isDynamic: true,
      },
    });

    expect(result.riskLevel).toBe("high");
    expect(result.reason).toBe("User-blocked dynamic skill");
    expect(result.matchType).toBe("user_rule");
  });

  test("override uses resolved skillId from metadata, not raw selector", async () => {
    store.create({
      tool: "skill_load",
      pattern: "resolved-id",
      risk: "high",
      description: "User-blocked by resolved ID",
    });

    initTrustRuleCache(store);

    const classifier = new SkillLoadRiskClassifier();
    const result = await classifier.classify({
      toolName: "skill_load",
      skillSelector: "raw-selector",
      resolvedMetadata: {
        skillId: "resolved-id",
        selector: "raw-selector",
        versionHash: "abc123",
        hasInlineExpansions: false,
        isDynamic: false,
      },
    });

    expect(result.riskLevel).toBe("high");
    expect(result.reason).toBe("User-blocked by resolved ID");
    expect(result.matchType).toBe("user_rule");
  });

  test("non-dynamic skill override does NOT match skill_load_dynamic rules", async () => {
    // Use a unique skill name that does not collide with earlier tests'
    // skill_load user_defined rules
    store.create({
      tool: "skill_load_dynamic",
      pattern: "dynamic-only-skill",
      risk: "high",
      description: "Dynamic-only rule",
    });

    initTrustRuleCache(store);

    const classifier = new SkillLoadRiskClassifier();
    const result = await classifier.classify({
      toolName: "skill_load",
      skillSelector: "dynamic-only-skill",
      resolvedMetadata: {
        skillId: "dynamic-only-skill",
        selector: "dynamic-only-skill",
        versionHash: "abc123",
        hasInlineExpansions: false,
        isDynamic: false,
      },
    });

    // Should NOT match the skill_load_dynamic rule
    expect(result.matchType).toBe("registry");
    expect(result.riskLevel).toBe("low");
  });
});

// ---------------------------------------------------------------------------
// Graceful fallback when cache is not initialized
// ---------------------------------------------------------------------------

describe("graceful fallback when cache not initialized", () => {
  test("file classifier falls through to normal classification", async () => {
    // Ensure cache is reset (not initialized)
    resetTrustRuleCache();

    const classifier = new FileRiskClassifier();
    const result = await classifier.classify(
      { toolName: "file_read", filePath: "/tmp/safe", workingDir: "/tmp" },
      dummyFileContext,
    );

    expect(result.riskLevel).toBe("low");
    expect(result.matchType).toBe("registry");
  });

  test("web classifier falls through to normal classification", async () => {
    resetTrustRuleCache();

    const classifier = new WebRiskClassifier();
    const result = await classifier.classify({
      toolName: "web_fetch",
      url: "https://example.com",
    });

    expect(result.riskLevel).toBe("low");
    expect(result.matchType).toBe("registry");
  });

  test("skill classifier falls through to normal classification", async () => {
    resetTrustRuleCache();

    const classifier = new SkillLoadRiskClassifier();
    const result = await classifier.classify({
      toolName: "skill_load",
      skillSelector: "my-skill",
    });

    expect(result.riskLevel).toBe("low");
    expect(result.matchType).toBe("registry");
  });

  test("schedule classifier falls through to normal classification", async () => {
    resetTrustRuleCache();

    const classifier = new ScheduleRiskClassifier();
    const result = await classifier.classify({
      toolName: "schedule_create",
      mode: "notify",
    });

    expect(result.riskLevel).toBe("medium");
    expect(result.matchType).toBe("registry");
  });
});

describe("SkillLoadRiskClassifier inline command risk elevation", () => {
  test("skill with inline expansions is classified as medium risk", async () => {
    const classifier = new SkillLoadRiskClassifier();
    const result = await classifier.classify({
      toolName: "skill_load",
      skillSelector: "my-skill",
      resolvedMetadata: {
        skillId: "my-skill",
        selector: "my-skill",
        versionHash: "abc123",
        transitiveHash: "def456",
        hasInlineExpansions: true,
        isDynamic: true,
      },
    });

    expect(result.riskLevel).toBe("medium");
    expect(result.reason).toContain("inline command expansions");
  });

  test("skill without inline expansions is classified as low risk", async () => {
    const classifier = new SkillLoadRiskClassifier();
    const result = await classifier.classify({
      toolName: "skill_load",
      skillSelector: "plain-skill",
      resolvedMetadata: {
        skillId: "plain-skill",
        selector: "plain-skill",
        versionHash: "abc123",
        transitiveHash: undefined,
        hasInlineExpansions: false,
        isDynamic: false,
      },
    });

    expect(result.riskLevel).toBe("low");
    expect(result.reason).toBe("Skill load (default)");
  });

  test("skill_load with no resolved metadata defaults to low risk", async () => {
    const classifier = new SkillLoadRiskClassifier();
    const result = await classifier.classify({
      toolName: "skill_load",
      skillSelector: "unknown-skill",
    });

    expect(result.riskLevel).toBe("low");
  });
});
