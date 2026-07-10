/**
 * Tests for the refactored checker.ts that delegates classification to the
 * gateway via ipcClassifyRisk. Each test mocks the IPC response to verify
 * that check() and classifyRisk() correctly map gateway results to the
 * existing PermissionCheckResult and RiskClassification types.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Module mocks ─────────────────────────────────────────────────────────────

// Mock feature flags to return false by default.
mock.module("../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: () => false,
}));

// `buildPolicyContext` (used by the integration tests below) precomputes the
// proc-to-skills gate via `isProcToSkillsActive`. Drive it through this slot so
// a test can put the production threading path in the active / inactive state.
let mockProcToSkillsActive = true;
mock.module("../config/memory-v3-gate.js", () => ({
  isProcToSkillsActive: () => mockProcToSkillsActive,
  isMemoryV3Live: () => mockProcToSkillsActive,
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
// `mockRefreshedThreshold` simulates the cache-bypassing refresh performed
// before a prompt is surfaced; `null` means "refresh failed, keep decision".
let mockCachedThreshold = "low";
let mockRefreshedThreshold: string | null = null;
// Records the cell query check() derives from the PolicyContext, so tests can
// assert the matrix coordinates that reach the threshold cascade.
const thresholdCallLog: Array<{
  fn: "get" | "refresh";
  cellQuery: Record<string, unknown> | undefined;
}> = [];
mock.module("./gateway-threshold-reader.js", () => ({
  getAutoApproveThreshold: async (
    _conversationId?: string,
    _executionContext?: string,
    cellQuery?: Record<string, unknown>,
  ) => {
    thresholdCallLog.push({ fn: "get", cellQuery });
    return mockCachedThreshold;
  },
  refreshAutoApproveThreshold: async (
    _conversationId?: string,
    _executionContext?: string,
    cellQuery?: Record<string, unknown>,
  ) => {
    thresholdCallLog.push({ fn: "refresh", cellQuery });
    return mockRefreshedThreshold;
  },
  _clearGlobalCacheForTesting: () => {},
}));

// Mock trust-store — no rules by default.
mock.module("./trust-store.js", () => ({
  findHighestPriorityRule: () => null,
  onRulesChanged: () => {},
}));

// Mock workspace policy.
let mockIsPathWithinWorkspaceRoot = true;
mock.module("./workspace-policy.js", () => ({
  isWorkspaceScopedInvocation: () => false,
  isPathWithinWorkspaceRoot: () => mockIsPathWithinWorkspaceRoot,
}));

// Mock tool registry — no tools by default. `getToolOwner` backs
// `buildPolicyContext` (used by the integration test below); core tools have no
// owner, so it returns undefined.
mock.module("../tools/registry.js", () => ({
  getTool: () => undefined,
  resolveTool: async () => undefined,
  getToolOwner: () => undefined,
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
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildPolicyContext } from "../tools/policy-context.js";
import type { Tool, ToolContext } from "../tools/types.js";
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
    mockIsContainerized = false;
    mockIpcClassifyRiskResult = undefined;
    mockCachedThreshold = "low";
    mockRefreshedThreshold = null;
    mockProcToSkillsActive = true;
    thresholdCallLog.length = 0;
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

    test("file-tool cache misses when a symlink target is retargeted", async () => {
      // File risk depends on filesystem state: the cache key folds in the
      // symlink-resolved target, so the same raw input must NOT return a stale
      // cached result after the symlink is pointed somewhere new.
      const dir = mkdtempSync(join(tmpdir(), "risk-cache-symlink-"));
      try {
        const benign = join(dir, "benign.txt");
        const other = join(dir, "other.txt");
        writeFileSync(benign, "ok");
        writeFileSync(other, "ok");
        const link = join(dir, "link.txt");
        symlinkSync(benign, link);

        mockIpcClassifyRiskResult = {
          risk: "low",
          reason: "benign",
          matchType: "registry",
          scopeOptions: [],
        };
        const first = await classifyRisk("file_read", { path: link });
        expect(first.level).toBe(RiskLevel.Low);

        // Retarget the symlink to a different real file; raw input unchanged.
        unlinkSync(link);
        symlinkSync(other, link);

        mockIpcClassifyRiskResult = {
          risk: "high",
          reason: "now sensitive",
          matchType: "registry",
          scopeOptions: [],
        };
        const second = await classifyRisk("file_read", { path: link });
        // Cache must have missed and re-classified against the new target.
        expect(second.level).toBe(RiskLevel.High);
        expect(second.reason).toBe("now sensitive");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
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

    test("overrides sandboxAutoApprove when symlink escape detected", async () => {
      mockIsPathWithinWorkspaceRoot = false;
      mockIpcClassifyRiskResult = {
        risk: "low",
        reason: "cat (default)",
        matchType: "registry",
        scopeOptions: [],
        sandboxAutoApprove: true,
        sandboxPathArgs: ["/workspace/escape/passwd"],
      };
      const result = await classifyRisk("bash", {
        command: "cat /workspace/escape/passwd",
      });
      expect((result as any).sandboxAutoApprove).toBe(false);
      mockIsPathWithinWorkspaceRoot = true;
    });

    test("preserves sandboxAutoApprove when path args resolve within workspace", async () => {
      mockIsPathWithinWorkspaceRoot = true;
      mockIpcClassifyRiskResult = {
        risk: "low",
        reason: "cat (default)",
        matchType: "registry",
        scopeOptions: [],
        sandboxAutoApprove: true,
        sandboxPathArgs: ["/workspace/file.txt"],
      };
      const result = await classifyRisk("bash", {
        command: "cat /workspace/file.txt",
      });
      expect((result as any).sandboxAutoApprove).toBe(true);
    });

    test("overrides sandboxAutoApprove when any path arg escapes", async () => {
      mockIsPathWithinWorkspaceRoot = false;
      mockIpcClassifyRiskResult = {
        risk: "low",
        reason: "cat (default)",
        matchType: "registry",
        scopeOptions: [],
        sandboxAutoApprove: true,
        sandboxPathArgs: ["/workspace/safe.txt", "/workspace/escape/passwd"],
      };
      const result = await classifyRisk("bash", {
        command: "cat /workspace/safe.txt && cat /workspace/escape/passwd",
      });
      expect((result as any).sandboxAutoApprove).toBe(false);
      mockIsPathWithinWorkspaceRoot = true;
    });

    test("no sandboxPathArgs means no symlink check (backward compat)", async () => {
      mockIsPathWithinWorkspaceRoot = false;
      mockIpcClassifyRiskResult = {
        risk: "low",
        reason: "ls (default)",
        matchType: "registry",
        scopeOptions: [],
        sandboxAutoApprove: true,
        // No sandboxPathArgs — e.g. older gateway that doesn't send them
      };
      const result = await classifyRisk("bash", { command: "ls" });
      expect((result as any).sandboxAutoApprove).toBe(true);
      mockIsPathWithinWorkspaceRoot = true;
    });

    test("cache hit re-runs symlink escape check after symlink retargeted", async () => {
      // First call: path args within workspace → sandboxAutoApprove true.
      mockIsPathWithinWorkspaceRoot = true;
      mockIpcClassifyRiskResult = {
        risk: "low",
        reason: "cat (default)",
        matchType: "registry",
        scopeOptions: [],
        sandboxAutoApprove: true,
        sandboxPathArgs: ["/workspace/escape/secret42.bin"],
      };
      const first = await classifyRisk("bash", {
        command: "cat /workspace/escape/secret42.bin",
      });
      expect((first as any).sandboxAutoApprove).toBe(true);

      // Second call with the same command: cache hit, but symlink now
      // resolves outside workspace. The cache hit must re-run the check
      // and override sandboxAutoApprove to false.
      mockIsPathWithinWorkspaceRoot = false;
      const second = await classifyRisk("bash", {
        command: "cat /workspace/escape/secret42.bin",
      });
      expect((second as any).sandboxAutoApprove).toBe(false);
      mockIsPathWithinWorkspaceRoot = true;
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

    // ── Stale-threshold refresh before prompting ────────────────────────────
    // The threshold reader caches values (5s conversation / 30s global TTL)
    // and no write path invalidates them, so a user who just switched to
    // Full access could still be prompted from the stale snapshot. check()
    // must re-read the threshold fresh before surfacing a prompt.

    test("re-evaluates with refreshed threshold instead of prompting (stale cache after Full access)", async () => {
      mockIpcClassifyRiskResult = {
        risk: "high",
        reason: "Recursive force delete",
        matchType: "registry",
        scopeOptions: [],
      };
      mockCachedThreshold = "low"; // stale cached value
      mockRefreshedThreshold = "high"; // user just selected Full access
      const result = await check(
        "bash",
        { command: "rm -rf /tmp/stale-cache-test" },
        "/home/user/project",
      );
      expect(result.decision).toBe("allow");
      expect(result.reason).toContain("within auto-approve threshold");
    });

    test("keeps the prompt when the threshold refresh fails", async () => {
      mockIpcClassifyRiskResult = {
        risk: "high",
        reason: "Recursive force delete",
        matchType: "registry",
        scopeOptions: [],
      };
      mockCachedThreshold = "low";
      mockRefreshedThreshold = null; // gateway unreachable during refresh
      const result = await check(
        "bash",
        { command: "rm -rf /tmp/refresh-failed-test" },
        "/home/user/project",
      );
      expect(result.decision).toBe("prompt");
    });

    test("keeps the prompt when the refreshed threshold matches the cached one", async () => {
      mockIpcClassifyRiskResult = {
        risk: "high",
        reason: "Recursive force delete",
        matchType: "registry",
        scopeOptions: [],
      };
      mockCachedThreshold = "low";
      mockRefreshedThreshold = "low"; // no change — still below the risk
      const result = await check(
        "bash",
        { command: "rm -rf /tmp/refresh-unchanged-test" },
        "/home/user/project",
      );
      expect(result.decision).toBe("prompt");
    });

    test("keeps the prompt when the refreshed threshold is stricter", async () => {
      mockIpcClassifyRiskResult = {
        risk: "medium",
        reason: "Network request (default)",
        matchType: "registry",
        scopeOptions: [],
      };
      mockCachedThreshold = "low";
      mockRefreshedThreshold = "none"; // user tightened to Strict mid-flight
      const result = await check(
        "network_request",
        { url: "https://api.example.com/refresh-stricter-test" },
        "/home/user/project",
      );
      expect(result.decision).toBe("prompt");
    });

    // ── Channel-permission matrix cell query ────────────────────────────────
    // check() derives the matrix coordinates (adapter × conversation type ×
    // channel ID × contact-type) from the PolicyContext and threads them into
    // both threshold reads, so the cell tier of the cascade governs every
    // policy rule without any rule changes.

    const HIGH_RISK_RESULT = {
      risk: "high",
      reason: "Recursive force delete",
      matchType: "registry",
      scopeOptions: [],
    } as const;

    test("threads the full cell query into the threshold read and the pre-prompt refresh", async () => {
      mockIpcClassifyRiskResult = { ...HIGH_RISK_RESULT, scopeOptions: [] };
      await check("bash", { command: "rm -rf /tmp/x" }, "/home/user/project", {
        conversationId: "conv-1",
        trustClass: "trusted_contact",
        sourceChannel: "slack",
        channelExternalId: "C123",
        channelConversationType: "dm",
      });

      const expectedQuery = {
        adapter: "slack",
        channelType: "dm",
        channelExternalId: "C123",
        contactType: "trusted_contact",
      };
      expect(thresholdCallLog).toEqual([
        { fn: "get", cellQuery: expectedQuery },
        // The high-risk prompt triggers the refresh with the same coordinates.
        { fn: "refresh", cellQuery: expectedQuery },
      ]);
    });

    test("omits unknown conversation type and missing channel ID from the cell query", async () => {
      mockIpcClassifyRiskResult = { ...HIGH_RISK_RESULT, scopeOptions: [] };
      await check("bash", { command: "rm -rf /tmp/x" }, "/home/user/project", {
        trustClass: "unknown",
        sourceChannel: "slack",
        // Slack non-DMs arrive without a public/private distinction, so the
        // conversation type is unset — the channel-type tier must not match.
        channelConversationType: undefined,
      });

      expect(thresholdCallLog[0]).toEqual({
        fn: "get",
        cellQuery: {
          adapter: "slack",
          channelType: undefined,
          channelExternalId: undefined,
          contactType: "unknown",
        },
      });
    });

    test("builds no cell query without a source channel", async () => {
      mockIpcClassifyRiskResult = { ...HIGH_RISK_RESULT, scopeOptions: [] };
      await check("bash", { command: "rm -rf /tmp/x" }, "/home/user/project", {
        trustClass: "guardian",
      });
      expect(thresholdCallLog[0]).toEqual({ fn: "get", cellQuery: undefined });
    });

    test("builds no cell query for an unrecognized trust class", async () => {
      mockIpcClassifyRiskResult = { ...HIGH_RISK_RESULT, scopeOptions: [] };
      await check("bash", { command: "rm -rf /tmp/x" }, "/home/user/project", {
        trustClass: "non_guardian",
        sourceChannel: "slack",
        channelExternalId: "C123",
      });
      expect(thresholdCallLog[0]).toEqual({ fn: "get", cellQuery: undefined });
    });

    // ── Memory-retrospective skill-authoring auto-grant ─────────────────────
    // The background retrospective guardian session (sourceChannel "vellum",
    // trustClass "guardian", origin "memory_retrospective") cannot answer
    // interactive prompts, so `scaffold_managed_skill`, `find_similar_skills`,
    // and `skill_load skill-management` resolve to allow without prompting. The
    // grant is scoped to that origin + those tools, and ONLY fires when the
    // feature is active (`procToSkillsActive: true`).

    const retrospectiveContext = {
      requestOrigin: "memory_retrospective",
      trustClass: "guardian",
      sourceChannel: "vellum",
      executionContext: "background" as const,
      procToSkillsActive: true,
    };

    test("allows scaffold_managed_skill for the retrospective origin without prompting", async () => {
      // High risk would normally force a prompt — the grant short-circuits
      // before classification, so no IPC result is needed.
      const result = await check(
        "scaffold_managed_skill",
        { skill_id: "deploy-preview" },
        "/home/user/project",
        retrospectiveContext,
      );
      expect(result.decision).toBe("allow");
    });

    test("allows find_similar_skills for the retrospective origin without prompting", async () => {
      mockIpcClassifyRiskResult = {
        risk: "high",
        reason: "Skill discovery",
        matchType: "registry",
        scopeOptions: [],
      };
      const result = await check(
        "find_similar_skills",
        { goal: "deploy a preview" },
        "/home/user/project",
        retrospectiveContext,
      );
      expect(result.decision).toBe("allow");
    });

    test("allows skill_load skill-management for the retrospective origin without prompting", async () => {
      const result = await check(
        "skill_load",
        { skill: "skill-management" },
        "/home/user/project",
        retrospectiveContext,
      );
      expect(result.decision).toBe("allow");
    });

    test("does not grant skill_load for a non skill-management skill", async () => {
      mockIpcClassifyRiskResult = {
        risk: "high",
        reason: "Dynamic skill load",
        matchType: "registry",
        scopeOptions: [],
      };
      const result = await check(
        "skill_load",
        { skill: "some-other-skill" },
        "/home/user/project",
        retrospectiveContext,
      );
      expect(result.decision).toBe("prompt");
    });

    test("does not grant for tools outside the scaffold/find/skill_load set", async () => {
      mockIpcClassifyRiskResult = {
        risk: "high",
        reason: "Managed skill delete",
        matchType: "registry",
        scopeOptions: [],
      };
      const result = await check(
        "delete_managed_skill",
        { skill_id: "deploy-preview" },
        "/home/user/project",
        retrospectiveContext,
      );
      expect(result.decision).toBe("prompt");
    });

    test("does not grant scaffold for an interactive (non-background) session", async () => {
      mockIpcClassifyRiskResult = {
        risk: "high",
        reason: "Skill scaffold",
        matchType: "registry",
        scopeOptions: [],
      };
      // A normal interactive turn carries no retrospective origin signals.
      const result = await check(
        "scaffold_managed_skill",
        { skill_id: "deploy-preview" },
        "/home/user/project",
        { executionContext: "conversation" },
      );
      expect(result.decision).toBe("prompt");
    });

    test("only the memory_retrospective origin grants skill authoring", async () => {
      mockIpcClassifyRiskResult = {
        risk: "high",
        reason: "Skill scaffold",
        matchType: "registry",
        scopeOptions: [],
      };
      // Same guardian/vellum background trust and active feature: the
      // consolidation origin does not authorize skill authoring; only the
      // retrospective origin holds this grant.
      const result = await check(
        "scaffold_managed_skill",
        { skill_id: "deploy-preview" },
        "/home/user/project",
        {
          requestOrigin: "memory_consolidation",
          trustClass: "guardian",
          sourceChannel: "vellum",
          executionContext: "background",
          procToSkillsActive: true,
        },
      );
      expect(result.decision).toBe("prompt");
    });

    test("does not grant scaffold for a different background origin", async () => {
      mockIpcClassifyRiskResult = {
        risk: "high",
        reason: "Skill scaffold",
        matchType: "registry",
        scopeOptions: [],
      };
      // Same guardian/vellum background trust, but a different origin (e.g.
      // the memory sweep job) must not inherit the retrospective grant.
      const result = await check(
        "scaffold_managed_skill",
        { skill_id: "deploy-preview" },
        "/home/user/project",
        {
          requestOrigin: "schedule",
          trustClass: "guardian",
          sourceChannel: "vellum",
          executionContext: "background",
          procToSkillsActive: true,
        },
      );
      expect(result.decision).toBe("prompt");
    });

    test("does not grant scaffold when trust is not guardian", async () => {
      mockIpcClassifyRiskResult = {
        risk: "high",
        reason: "Skill scaffold",
        matchType: "registry",
        scopeOptions: [],
      };
      const result = await check(
        "scaffold_managed_skill",
        { skill_id: "deploy-preview" },
        "/home/user/project",
        {
          requestOrigin: "memory_retrospective",
          trustClass: "unknown",
          sourceChannel: "vellum",
          executionContext: "background",
          procToSkillsActive: true,
        },
      );
      expect(result.decision).toBe("prompt");
    });

    test("does not grant scaffold when proc-to-skills is inactive (flag off / v3 not live)", async () => {
      mockIpcClassifyRiskResult = {
        risk: "high",
        reason: "Skill scaffold",
        matchType: "registry",
        scopeOptions: [],
      };
      // The exact retrospective origin/trust/channel, but the feature is
      // inactive — `procToSkillsActive` is not true — so the grant must NOT
      // fire and the high-risk tool prompts.
      const result = await check(
        "scaffold_managed_skill",
        { skill_id: "deploy-preview" },
        "/home/user/project",
        { ...retrospectiveContext, procToSkillsActive: false },
      );
      expect(result.decision).toBe("prompt");
    });

    // ── Integration: production `buildPolicyContext` → `check` path ──────────
    // The hand-built-PolicyContext tests above prove the grant LOGIC. These
    // exercise the WIRING: a `ToolContext` (the shape the agent loop actually
    // builds — see conversation-tool-setup.ts) is run through the real
    // `buildPolicyContext`, and only then handed to `check`. Without the
    // origin/trust/channel threading, `buildPolicyContext` would drop those
    // fields and the grant would be dead code.

    /** A bare core tool — `buildPolicyContext` reads only `tool.name`/owner. */
    const scaffoldTool = {
      name: "scaffold_managed_skill",
    } as unknown as Tool;

    /** The ToolContext a memory-retrospective pass produces. */
    const retrospectiveToolContext: ToolContext = {
      conversationId: "conv-retro",
      workingDir: "/home/user/project",
      trustClass: "guardian",
      executionChannel: "vellum",
      requestOrigin: "memory_retrospective",
      isInteractive: false,
    };

    test("grant fires through the real buildPolicyContext path for the retrospective turn", async () => {
      // High risk would normally force a prompt; the grant short-circuits it.
      mockIpcClassifyRiskResult = {
        risk: "high",
        reason: "Skill scaffold",
        matchType: "registry",
        scopeOptions: [],
      };
      const policyContext = buildPolicyContext(
        scaffoldTool,
        retrospectiveToolContext,
      );
      // Prove the threading: buildPolicyContext copied the ToolContext signals
      // and stamped the active proc-to-skills gate.
      expect(policyContext.requestOrigin).toBe("memory_retrospective");
      expect(policyContext.trustClass).toBe("guardian");
      expect(policyContext.sourceChannel).toBe("vellum");
      expect(policyContext.procToSkillsActive).toBe(true);

      const result = await check(
        "scaffold_managed_skill",
        { skill_id: "deploy-preview" },
        "/home/user/project",
        policyContext,
      );
      expect(result.decision).toBe("allow");
    });

    test("grant does NOT fire for a normal interactive tool call via buildPolicyContext", async () => {
      mockIpcClassifyRiskResult = {
        risk: "high",
        reason: "Skill scaffold",
        matchType: "registry",
        scopeOptions: [],
      };
      // A normal interactive turn: a guardian on the desktop, no retrospective
      // origin. buildPolicyContext leaves `requestOrigin` unset, so the grant
      // must not fire and the high-risk tool prompts.
      const interactiveContext: ToolContext = {
        conversationId: "conv-chat",
        workingDir: "/home/user/project",
        trustClass: "guardian",
        executionChannel: "vellum",
        isInteractive: true,
      };
      const policyContext = buildPolicyContext(
        scaffoldTool,
        interactiveContext,
      );
      expect(policyContext.requestOrigin).toBeUndefined();

      const result = await check(
        "scaffold_managed_skill",
        { skill_id: "deploy-preview" },
        "/home/user/project",
        policyContext,
      );
      expect(result.decision).toBe("prompt");
    });

    test("grant does NOT fire when proc-to-skills is inactive, even for the retrospective turn", async () => {
      // Same retrospective ToolContext, but the feature is inactive (flag off
      // or v3 not live). buildPolicyContext stamps `procToSkillsActive: false`,
      // so the grant is dead and the high-risk scaffold prompts.
      mockProcToSkillsActive = false;
      mockIpcClassifyRiskResult = {
        risk: "high",
        reason: "Skill scaffold",
        matchType: "registry",
        scopeOptions: [],
      };
      const policyContext = buildPolicyContext(
        scaffoldTool,
        retrospectiveToolContext,
      );
      expect(policyContext.procToSkillsActive).toBe(false);
      expect(policyContext.requestOrigin).toBe("memory_retrospective");

      const result = await check(
        "scaffold_managed_skill",
        { skill_id: "deploy-preview" },
        "/home/user/project",
        policyContext,
      );
      expect(result.decision).toBe("prompt");
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
