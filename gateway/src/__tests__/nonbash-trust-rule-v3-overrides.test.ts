import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { initGatewayDb, resetGatewayDb } from "../db/connection.js";
import { TrustRuleV3Store } from "../db/trust-rule-v3-store.js";
import {
  initTrustRuleV3Cache,
  resetTrustRuleV3Cache,
} from "../risk/trust-rule-v3-cache.js";
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

let store: TrustRuleV3Store;

const dummyFileContext: FileClassificationContext = {
  protectedDir: "/tmp/test-protected",
  deprecatedDir: "/tmp/test-deprecated",
  hooksDir: "/tmp/test-hooks",
  skillSourceDirs: [],
};

beforeEach(async () => {
  resetGatewayDb();
  await initGatewayDb();
  store = new TrustRuleV3Store();
});

afterEach(() => {
  resetTrustRuleV3Cache();
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

    initTrustRuleV3Cache(store);

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

    initTrustRuleV3Cache(store);

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

    initTrustRuleV3Cache(store);

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

    initTrustRuleV3Cache(store);

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

    initTrustRuleV3Cache(store);

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

    initTrustRuleV3Cache(store);

    const classifier = new FileRiskClassifier();
    const result = await classifier.classify(
      { toolName: "file_read", filePath: "/etc/passwd", workingDir: "/tmp" },
      dummyFileContext,
    );

    // Should fall through to the classifier's built-in logic, not the default rule
    expect(result.matchType).toBe("registry");
  });

  test("default rule with origin=default and userModified=false does not override web classifier", async () => {
    store.upsertDefault({
      id: "default-web-fetch-test",
      tool: "web_fetch",
      pattern: "https://example.com",
      risk: "high",
      description: "Default high-risk URL",
    });

    initTrustRuleV3Cache(store);

    const classifier = new WebRiskClassifier();
    const result = await classifier.classify({
      toolName: "web_fetch",
      url: "https://example.com",
    });

    // Should fall through to the classifier's built-in logic
    expect(result.matchType).toBe("registry");
  });

  test("default rule with origin=default and userModified=false does not override skill classifier", async () => {
    store.upsertDefault({
      id: "default-skill-load-test",
      tool: "skill_load",
      pattern: "my-skill",
      risk: "high",
      description: "Default high-risk skill",
    });

    initTrustRuleV3Cache(store);

    const classifier = new SkillLoadRiskClassifier();
    const result = await classifier.classify({
      toolName: "skill_load",
      skillSelector: "my-skill",
    });

    // Should fall through to the classifier's built-in logic
    expect(result.matchType).toBe("registry");
  });

  test("default rule with origin=default and userModified=false does not override schedule classifier", async () => {
    store.upsertDefault({
      id: "default-schedule-create-test",
      tool: "schedule_create",
      pattern: "cron",
      risk: "high",
      description: "Default high-risk schedule",
    });

    initTrustRuleV3Cache(store);

    const classifier = new ScheduleRiskClassifier();
    const result = await classifier.classify({
      toolName: "schedule_create",
      mode: "cron",
    });

    // Should fall through to the classifier's built-in logic
    expect(result.matchType).toBe("registry");
  });
});

// ---------------------------------------------------------------------------
// Graceful fallback when cache is not initialized
// ---------------------------------------------------------------------------

describe("graceful fallback when cache not initialized", () => {
  test("file classifier falls through to normal classification", async () => {
    // Ensure cache is reset (not initialized)
    resetTrustRuleV3Cache();

    const classifier = new FileRiskClassifier();
    const result = await classifier.classify(
      { toolName: "file_read", filePath: "/tmp/safe", workingDir: "/tmp" },
      dummyFileContext,
    );

    expect(result.riskLevel).toBe("low");
    expect(result.matchType).toBe("registry");
  });

  test("web classifier falls through to normal classification", async () => {
    resetTrustRuleV3Cache();

    const classifier = new WebRiskClassifier();
    const result = await classifier.classify({
      toolName: "web_fetch",
      url: "https://example.com",
    });

    expect(result.riskLevel).toBe("low");
    expect(result.matchType).toBe("registry");
  });

  test("skill classifier falls through to normal classification", async () => {
    resetTrustRuleV3Cache();

    const classifier = new SkillLoadRiskClassifier();
    const result = await classifier.classify({
      toolName: "skill_load",
      skillSelector: "my-skill",
    });

    expect(result.riskLevel).toBe("low");
    expect(result.matchType).toBe("registry");
  });

  test("schedule classifier falls through to normal classification", async () => {
    resetTrustRuleV3Cache();

    const classifier = new ScheduleRiskClassifier();
    const result = await classifier.classify({
      toolName: "schedule_create",
      mode: "notify",
    });

    expect(result.riskLevel).toBe("medium");
    expect(result.matchType).toBe("registry");
  });
});
