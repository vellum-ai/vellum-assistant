/**
 * Tests for the refactored checker.ts that delegates classification to the
 * gateway via ipcClassifyRisk. Each test mocks the IPC response to verify
 * that check() and classifyRisk() correctly map gateway results to the
 * existing PermissionCheckResult and RiskClassification types.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Module mocks ─────────────────────────────────────────────────────────────

// Silence logger output during tests.
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

const testConfig = {
  skills: { load: { extraDirs: [] as string[] } },
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

// Mock feature flags to return false by default.
mock.module("../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: () => false,
}));

// Mock skill resolution — return null by default (no skill found).
mock.module("../config/skills.js", () => ({
  loadSkillCatalog: () => [],
  resolveSkillSelector: () => ({ skill: null }),
}));

// Mock skills helpers used for file context building.
mock.module("../skills/path-classifier.js", () => ({
  normalizeFilePath: (p: string) => p,
  getSkillRoots: () => ["/mock/skills/managed/", "/mock/skills/bundled/"],
}));

mock.module("../skills/include-graph.js", () => ({
  indexCatalogById: () => new Map(),
}));

mock.module("../skills/transitive-version-hash.js", () => ({
  computeTransitiveSkillVersionHash: () => "mock-transitive-hash",
}));

mock.module("../skills/version-hash.js", () => ({
  computeSkillVersionHash: () => "mock-version-hash",
}));

// Mock containerized check.
let mockIsContainerized = false;
mock.module("../config/env-registry.js", () => ({
  getIsContainerized: () => mockIsContainerized,
}));

// Mock platform utilities.
const mockWorkspaceDir = "/mock/workspace";
mock.module("../util/platform.js", () => ({
  getWorkspaceDir: () => mockWorkspaceDir,
  getProtectedDir: () => "/mock/protected",
  getWorkspaceHooksDir: () => "/mock/workspace/hooks",
  getDeprecatedDir: () => "/mock/workspace/deprecated",
}));

// Mock gateway threshold reader — return "low" by default (conversation context default).
mock.module("./gateway-threshold-reader.js", () => ({
  getAutoApproveThreshold: async () => "low",
  _clearGlobalCacheForTesting: () => {},
}));

// Mock trust-store — no rules by default.
mock.module("./trust-store.js", () => ({
  findHighestPriorityRule: () => null,
  onRulesChanged: () => {},
}));

// Mock workspace policy.
mock.module("./workspace-policy.js", () => ({
  isWorkspaceScopedInvocation: () => false,
  isPathWithinWorkspaceRoot: () => false,
}));

// Mock tool registry — no tools by default.
mock.module("../tools/registry.js", () => ({
  getTool: () => undefined,
}));

// Mock URL safety helpers.
mock.module("../tools/network/url-safety.js", () => ({
  looksLikeHostPortShorthand: () => false,
  looksLikePathOnlyInput: () => false,
}));

// ── ipcClassifyRisk mock ─────────────────────────────────────────────────────
// This is the core mock — all classification goes through this.

import type { ClassificationResult } from "./ipc-risk-types.js";

let mockIpcClassifyRiskResult: ClassificationResult | undefined;

mock.module("../ipc/gateway-client.js", () => ({
  ipcClassifyRisk: async () => mockIpcClassifyRiskResult,
  ipcCall: async () => undefined,
  ipcCallPersistent: async () => undefined,
  resetPersistentClient: () => {},
}));

// ── Import the module under test AFTER mocks are set up ──────────────────────

import {
  check,
  classifyRisk,
  generateAllowlistOptions,
  generateScopeOptions,
  getCachedAssessment,
} from "./checker.js";
import { RiskLevel } from "./types.js";

// ── Test suite ───────────────────────────────────────────────────────────────

describe("Permission Checker (gateway IPC)", () => {
  beforeEach(() => {
    testConfig.skills = { load: { extraDirs: [] } };
    mockIsContainerized = false;
    mockIpcClassifyRiskResult = undefined;
  });

  // ── classifyRisk ──────────────────────────────────────────────────────────

  describe("classifyRisk", () => {
    test("maps gateway 'low' risk to RiskLevel.Low", async () => {
      mockIpcClassifyRiskResult = {
        risk: "low",
        reason: "File read (default)",
        matchType: "registry",
        scopeOptions: [],
      };
      const result = await classifyRisk("file_read", { path: "/tmp/foo.txt" });
      expect(result.level).toBe(RiskLevel.Low);
      expect(result.reason).toBe("File read (default)");
    });

    test("maps gateway 'medium' risk to RiskLevel.Medium", async () => {
      mockIpcClassifyRiskResult = {
        risk: "medium",
        reason: "Network request (default)",
        matchType: "registry",
        scopeOptions: [],
      };
      const result = await classifyRisk("network_request", {
        url: "https://api.example.com",
      });
      expect(result.level).toBe(RiskLevel.Medium);
    });

    test("maps gateway 'high' risk to RiskLevel.High", async () => {
      mockIpcClassifyRiskResult = {
        risk: "high",
        reason: "Recursive force delete",
        matchType: "registry",
        scopeOptions: [],
      };
      const result = await classifyRisk("bash", { command: "rm -rf /" });
      expect(result.level).toBe(RiskLevel.High);
      expect(result.reason).toBe("Recursive force delete");
    });

    test("maps gateway 'unknown' risk to RiskLevel.Medium", async () => {
      mockIpcClassifyRiskResult = {
        risk: "unknown",
        reason: "Unknown command",
        matchType: "unknown",
        scopeOptions: [],
      };
      const result = await classifyRisk("bash", {
        command: "some-unknown-tool",
      });
      expect(result.level).toBe(RiskLevel.Medium);
    });

    test("throws when gateway returns undefined (unreachable)", async () => {
      mockIpcClassifyRiskResult = undefined;
      await expect(classifyRisk("bash", { command: "ls" })).rejects.toThrow(
        /Gateway IPC classify_risk failed/,
      );
    });

    test("caches results for identical inputs", async () => {
      mockIpcClassifyRiskResult = {
        risk: "low",
        reason: "Cached test",
        matchType: "registry",
        scopeOptions: [],
      };

      // First call
      const result1 = await classifyRisk("file_read", { path: "/tmp/a.txt" });
      expect(result1.level).toBe(RiskLevel.Low);

      // Change the mock to verify cache is used
      mockIpcClassifyRiskResult = {
        risk: "high",
        reason: "Should not see this",
        matchType: "registry",
        scopeOptions: [],
      };

      // Second call with same inputs should return cached result
      const result2 = await classifyRisk("file_read", { path: "/tmp/a.txt" });
      expect(result2.level).toBe(RiskLevel.Low);
      expect(result2.reason).toBe("Cached test");
    });

    test("preserves commandCandidates from gateway response", async () => {
      mockIpcClassifyRiskResult = {
        risk: "low",
        reason: "ls (default)",
        matchType: "registry",
        scopeOptions: [],
        commandCandidates: ["ls -la", "action:ls"],
      };
      // Use unique command to avoid cache hits from other tests
      const result = await classifyRisk("bash", { command: "ls -la" });
      expect((result as any).commandCandidates).toEqual([
        "ls -la",
        "action:ls",
      ]);
    });

    test("preserves sandboxAutoApprove from gateway response", async () => {
      mockIpcClassifyRiskResult = {
        risk: "low",
        reason: "pwd (default)",
        matchType: "registry",
        scopeOptions: [],
        sandboxAutoApprove: true,
      };
      // Use unique command to avoid cache hits
      const result = await classifyRisk("bash", { command: "pwd" });
      expect((result as any).sandboxAutoApprove).toBe(true);
    });

    test("preserves allowlistOptions from gateway response", async () => {
      const mockOptions = [
        { label: "date", description: "Exact command", pattern: "date" },
        {
          label: "action:date",
          description: "Any date command",
          pattern: "action:date",
        },
      ];
      mockIpcClassifyRiskResult = {
        risk: "low",
        reason: "date (default)",
        matchType: "registry",
        scopeOptions: [],
        allowlistOptions: mockOptions,
      };
      // Use unique command to avoid cache hits
      const result = await classifyRisk("bash", { command: "date" });
      expect((result as any).allowlistOptions).toEqual(mockOptions);
    });
  });

  // ── classifyRisk IPC param building ───────────────────────────────────────

  describe("classifyRisk IPC params", () => {
    // We verify param building indirectly by checking the function doesn't
    // throw and returns the expected result for each tool type.

    test("builds params for bash tool", async () => {
      mockIpcClassifyRiskResult = {
        risk: "medium",
        reason: "Test",
        matchType: "registry",
        scopeOptions: [],
      };
      const result = await classifyRisk(
        "bash",
        { command: "curl https://example.com" },
        "/home/user/project",
      );
      expect(result.level).toBe(RiskLevel.Medium);
    });

    test("builds params for file tools", async () => {
      mockIpcClassifyRiskResult = {
        risk: "low",
        reason: "File read (default)",
        matchType: "registry",
        scopeOptions: [],
      };
      const result = await classifyRisk(
        "file_read",
        { path: "/tmp/foo.txt" },
        "/home/user/project",
      );
      expect(result.level).toBe(RiskLevel.Low);
    });

    test("builds params for host file tools", async () => {
      mockIpcClassifyRiskResult = {
        risk: "medium",
        reason: "Host file read (default)",
        matchType: "registry",
        scopeOptions: [],
      };
      const result = await classifyRisk("host_file_read", {
        file_path: "/etc/passwd",
      });
      expect(result.level).toBe(RiskLevel.Medium);
    });

    test("builds params for web tools", async () => {
      mockIpcClassifyRiskResult = {
        risk: "low",
        reason: "Web fetch (default)",
        matchType: "registry",
        scopeOptions: [],
      };
      const result = await classifyRisk("web_fetch", {
        url: "https://example.com",
      });
      expect(result.level).toBe(RiskLevel.Low);
    });

    test("builds params for skill tools", async () => {
      mockIpcClassifyRiskResult = {
        risk: "low",
        reason: "Skill load (default)",
        matchType: "registry",
        scopeOptions: [],
      };
      const result = await classifyRisk("skill_load", {
        skill: "test-skill",
      });
      expect(result.level).toBe(RiskLevel.Low);
    });

    test("builds params for schedule tools", async () => {
      mockIpcClassifyRiskResult = {
        risk: "high",
        reason: "Script mode schedule",
        matchType: "registry",
        scopeOptions: [],
      };
      const result = await classifyRisk("schedule_create", {
        mode: "script",
        script: "echo hello",
      });
      expect(result.level).toBe(RiskLevel.High);
    });

    test("builds params for unknown tools", async () => {
      mockIpcClassifyRiskResult = {
        risk: "medium",
        reason: "Unknown tool",
        matchType: "unknown",
        scopeOptions: [],
      };
      const result = await classifyRisk("custom_mcp_tool", {
        data: "test",
      });
      expect(result.level).toBe(RiskLevel.Medium);
    });
  });

  // ── check() ───────────────────────────────────────────────────────────────

  describe("check", () => {
    test("allows low risk tools in workspace mode", async () => {
      mockIpcClassifyRiskResult = {
        risk: "low",
        reason: "File read (default)",
        matchType: "registry",
        scopeOptions: [],
      };
      const result = await check(
        "file_read",
        { path: "/tmp/check-allow.txt" },
        "/home/user/project",
      );
      expect(result.decision).toBe("allow");
    });

    test("prompts for high risk commands", async () => {
      mockIpcClassifyRiskResult = {
        risk: "high",
        reason: "Recursive force delete",
        matchType: "registry",
        scopeOptions: [],
      };
      const result = await check(
        "bash",
        { command: "rm -rf /" },
        "/home/user/project",
      );
      expect(result.decision).toBe("prompt");
      expect(result.reason).toContain("Recursive force delete");
    });

    test("uses gateway-provided commandCandidates for bash tools", async () => {
      mockIpcClassifyRiskResult = {
        risk: "low",
        reason: "whoami (default)",
        matchType: "registry",
        scopeOptions: [],
        commandCandidates: ["whoami", "action:whoami"],
      };
      // The check function should use the gateway-provided candidates
      // for trust rule matching — verifiable because it doesn't crash
      // (no local shell parsing needed).
      const result = await check(
        "bash",
        { command: "whoami" },
        "/home/user/project",
      );
      expect(result.decision).toBe("allow");
    });

    test("uses gateway-provided sandboxAutoApprove", async () => {
      mockIpcClassifyRiskResult = {
        risk: "low",
        reason: "hostname (default)",
        matchType: "registry",
        scopeOptions: [],
        sandboxAutoApprove: true,
      };
      const result = await check(
        "bash",
        { command: "hostname" },
        "/home/user/project",
      );
      // sandboxAutoApprove should be passed through to approval context
      expect(result.decision).toBe("allow");
    });

    test("enriches reason with classifier explanation", async () => {
      mockIpcClassifyRiskResult = {
        risk: "high",
        reason: "Force push detected",
        matchType: "registry",
        scopeOptions: [],
      };
      const result = await check(
        "bash",
        { command: "git push --force" },
        "/home/user/project",
      );
      expect(result.reason).toContain("Force push detected");
    });

    test("throws when gateway is unreachable during check", async () => {
      mockIpcClassifyRiskResult = undefined;
      await expect(
        check(
          "bash",
          { command: "gateway-unreachable-test-cmd" },
          "/home/user/project",
        ),
      ).rejects.toThrow(/Gateway IPC classify_risk failed/);
    });
  });

  // ── generateAllowlistOptions ──────────────────────────────────────────────

  describe("generateAllowlistOptions", () => {
    test("returns gateway-provided options from assessment cache", async () => {
      const mockOptions = [
        { label: "wc -l", description: "Exact command", pattern: "wc -l" },
        {
          label: "action:wc",
          description: "Any wc command",
          pattern: "action:wc",
        },
      ];
      mockIpcClassifyRiskResult = {
        risk: "low",
        reason: "wc (default)",
        matchType: "registry",
        scopeOptions: [],
        allowlistOptions: mockOptions,
      };

      // First classify to populate the cache
      await classifyRisk("bash", { command: "wc -l" });

      // Then generate options should use cached assessment
      const options = await generateAllowlistOptions("bash", {
        command: "wc -l",
      });
      expect(options).toEqual(mockOptions);
    });

    test("falls back to per-tool strategy for file tools without cached options", async () => {
      const options = await generateAllowlistOptions("file_read", {
        path: "/tmp/foo.txt",
      });
      // Should get file-specific options (exact path, directory wildcards, etc.)
      expect(options.length).toBeGreaterThan(0);
      expect(options[0].pattern).toContain("file_read:");
    });

    test("returns default option for unknown tools", async () => {
      const options = await generateAllowlistOptions("custom_tool", {});
      expect(options).toEqual([
        { label: "*", description: "Everything", pattern: "*" },
      ]);
    });
  });

  // ── getCachedAssessment ───────────────────────────────────────────────────

  describe("getCachedAssessment", () => {
    test("returns cached assessment after classifyRisk call", async () => {
      mockIpcClassifyRiskResult = {
        risk: "low",
        reason: "Test assessment",
        matchType: "registry",
        scopeOptions: [],
        allowlistOptions: [
          { label: "test", description: "Test", pattern: "test" },
        ],
      };

      await classifyRisk("bash", { command: "echo test" });

      const assessment = getCachedAssessment("bash", { command: "echo test" });
      expect(assessment).toBeDefined();
      expect(assessment!.riskLevel).toBe("low");
      expect(assessment!.reason).toBe("Test assessment");
      expect(assessment!.allowlistOptions).toHaveLength(1);
    });

    test("returns undefined for uncached tool invocations", () => {
      const assessment = getCachedAssessment("bash", { command: "not-cached" });
      expect(assessment).toBeUndefined();
    });

    test("preserves scopeOptions from gateway result in cached assessment", async () => {
      mockIpcClassifyRiskResult = {
        risk: "low",
        reason: "Registry match",
        matchType: "registry",
        scopeOptions: [
          { pattern: "echo *", label: "only 'echo' commands" },
          { pattern: ".*", label: "everywhere" },
        ],
        allowlistOptions: [],
      };

      await classifyRisk("bash", { command: "echo hello" });

      const assessment = getCachedAssessment("bash", { command: "echo hello" });
      expect(assessment).toBeDefined();
      expect(assessment!.scopeOptions).toHaveLength(2);
      expect(assessment!.scopeOptions[0]).toEqual({
        pattern: "echo *",
        label: "only 'echo' commands",
      });
      expect(assessment!.scopeOptions[1]).toEqual({
        pattern: ".*",
        label: "everywhere",
      });
    });

    test("preserves directoryScopeOptions from gateway result in cached assessment", async () => {
      mockIpcClassifyRiskResult = {
        risk: "medium",
        reason: "Filesystem write",
        matchType: "registry",
        scopeOptions: [],
        allowlistOptions: [],
        directoryScopeOptions: [
          { scope: "/workspace/scratch/*", label: "In scratch/" },
          { scope: "/workspace/*", label: "In workspace/" },
          { scope: "everywhere", label: "everywhere" },
        ],
      };

      await classifyRisk("file_write", { path: "/workspace/scratch/out.txt" });

      const assessment = getCachedAssessment("file_write", {
        path: "/workspace/scratch/out.txt",
      });
      expect(assessment).toBeDefined();
      expect(assessment!.directoryScopeOptions).toHaveLength(3);
      expect(assessment!.directoryScopeOptions![0]).toEqual({
        scope: "/workspace/scratch/*",
        label: "In scratch/",
      });
      expect(assessment!.directoryScopeOptions![1]).toEqual({
        scope: "/workspace/*",
        label: "In workspace/",
      });
      expect(assessment!.directoryScopeOptions![2]).toEqual({
        scope: "everywhere",
        label: "everywhere",
      });
    });
  });

  // ── generateScopeOptions (kept in checker.ts) ─────────────────────────────

  describe("generateScopeOptions", () => {
    test("returns directory-based scope options for bash", () => {
      const options = generateScopeOptions("/home/user/project", "bash");
      expect(options.length).toBeGreaterThan(0);
      // Should include the project directory and "everywhere"
      expect(options[options.length - 1].label).toBe("everywhere");
    });

    test("returns empty for non-scope-aware tools", () => {
      const options = generateScopeOptions("/home/user/project", "web_fetch");
      expect(options).toEqual([]);
    });
  });
});
