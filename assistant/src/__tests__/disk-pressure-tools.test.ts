import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { SkillProjectionCache } from "../daemon/conversation-skill-tools.js";
import type { SkillProjectionContext } from "../daemon/conversation-tool-setup.js";
import type { Message, ToolDefinition } from "../providers/types.js";
import type { Tool } from "../tools/types.js";
import type { DiskUsageInfo } from "../util/disk-usage.js";

let diskSample: DiskUsageInfo | null = null;
let projectedSkillToolNames = new Set<string>();
let testWorkspaceDir: string | null = null;
let previousWorkspaceDir: string | undefined;

const mockConfig = {
  timeouts: {
    shellDefaultTimeoutSec: 120,
    shellMaxTimeoutSec: 600,
    permissionTimeoutSec: 300,
  },
  sandbox: {
    enabled: false,
    backend: "native" as const,
    docker: {
      image: "vellum-sandbox:latest",
      cpus: 1,
      memoryMb: 512,
      pidsLimit: 256,
      network: "none" as const,
    },
  },
  permissions: { mode: "workspace" as const },
};

mock.module("../config/loader.js", () => ({
  getConfig: () => mockConfig,
  getConfigReadOnly: () => mockConfig,
  loadConfig: () => mockConfig,
  applyNestedDefaults: () => mockConfig,
  deepMergeOverwrite: (_base: unknown, override: unknown) => override,
  invalidateConfigCache: () => undefined,
  loadRawConfig: () => ({}),
  saveRawConfig: () => undefined,
  getNestedValue: () => undefined,
  setNestedValue: () => undefined,
  mergeDefaultWorkspaceConfig: (config: unknown) => config,
  API_KEY_PROVIDERS: [] as const,
  _appendQuarantineBulletin: () => undefined,
}));

mock.module("../daemon/conversation-skill-tools.js", () => ({
  projectSkillTools: mock((_history: Message[], _opts: unknown) => ({
    allowedToolNames: new Set(projectedSkillToolNames),
    toolDefinitions: [],
  })),
  resetSkillToolProjection: () => undefined,
}));

mock.module("../runtime/agent-wake.js", () => ({
  wakeAgentForOpportunity: async () => undefined,
}));

mock.module("../runtime/assistant-event.js", () => ({
  buildAssistantEvent: (message: unknown, conversationId?: string) => ({
    id: "event-test",
    type: "message",
    timestamp: new Date().toISOString(),
    conversationId,
    message,
  }),
}));

mock.module("../runtime/assistant-event-hub.js", () => ({
  AssistantEventHub: class {},
  broadcastMessage: () => {},
  capabilityForMessageType: () => undefined,
  assistantEventHub: {
    publish: async () => undefined,
    listClientsByCapability: () => [],
  },
}));

mock.module("../util/disk-usage.js", () => ({
  getDiskUsageInfo: () => diskSample,
}));

const { _setOverridesForTesting } =
  await import("../config/assistant-feature-flags.js");
const {
  DISK_PRESSURE_THRESHOLD_PERCENT,
  __resetDiskPressureGuardForTests,
  evaluateDiskPressureNow,
} = await import("../daemon/disk-pressure-guard.js");
const { createResolveToolsCallback } =
  await import("../daemon/conversation-tool-setup.js");
const { ToolApprovalHandler } =
  await import("../tools/tool-approval-handler.js");
const { loadSkillBySelector } = await import("../config/skills.js");
const {
  _clearRegistryForTesting,
  listBackgroundTools,
  registerBackgroundTool,
} = await import("../tools/background-tool-registry.js");
const { registerMcpTools, registerTool, unregisterAllMcpTools } =
  await import("../tools/registry.js");
const { shellTool } = await import("../tools/terminal/shell.js");
const { hostShellTool } = await import("../tools/host-terminal/host-shell.js");
const { skillLoadTool } = await import("../tools/skills/load.js");

function makeToolDef(name: string): ToolDefinition {
  return { name, description: `${name} tool`, input_schema: {} };
}

function makeMcpTool(name: string): Tool {
  return {
    name,
    description: `${name} tool`,
    category: "mcp",
    defaultRiskLevel: "low" as Tool["defaultRiskLevel"],
    origin: "mcp",
    ownerMcpServerId: "example",
    getDefinition: () => makeToolDef(name),
    execute: async () => ({ content: "", isError: false }),
  };
}

function makeProjectionCtx(
  overrides: Partial<SkillProjectionContext> = {},
): SkillProjectionContext {
  return {
    skillProjectionState: new Map(),
    skillProjectionCache: {} as SkillProjectionCache,
    coreToolNames: new Set(),
    toolsDisabledDepth: 0,
    ...overrides,
  };
}

function setDiskUsage(usedMb: number, totalMb = 100): void {
  diskSample = {
    path: "/workspace",
    totalMb,
    usedMb,
    freeMb: Math.max(0, totalMb - usedMb),
  };
}

function writeManagedSkill(
  id: string,
  body: string,
  toolsJson?: Record<string, unknown>,
): void {
  if (!testWorkspaceDir) {
    throw new Error("test workspace not initialized");
  }
  const skillDir = join(testWorkspaceDir, "skills", id);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), body);
  if (toolsJson) {
    writeFileSync(join(skillDir, "TOOLS.json"), JSON.stringify(toolsJson));
  }
}

beforeEach(() => {
  previousWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
  testWorkspaceDir = mkdtempSync(join(tmpdir(), "vellum-disk-pressure-tools-"));
  process.env.VELLUM_WORKSPACE_DIR = testWorkspaceDir;
  _clearRegistryForTesting();
  registerTool(skillLoadTool);
  unregisterAllMcpTools();
  __resetDiskPressureGuardForTests();
  _setOverridesForTesting({ "safe-storage-limits": true });
  projectedSkillToolNames = new Set<string>();
  setDiskUsage(10);
});

afterEach(() => {
  _clearRegistryForTesting();
  unregisterAllMcpTools();
  __resetDiskPressureGuardForTests();
  _setOverridesForTesting({});
  projectedSkillToolNames = new Set<string>();
  diskSample = null;
  if (previousWorkspaceDir === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = previousWorkspaceDir;
  }
  previousWorkspaceDir = undefined;
  if (testWorkspaceDir) {
    rmSync(testWorkspaceDir, { recursive: true, force: true });
  }
  testWorkspaceDir = null;
});

describe("disk pressure cleanup tool restrictions", () => {
  test("cleanup mode hides non-allowlisted tools and restores normal tools after the turn", () => {
    projectedSkillToolNames = new Set(["cleanup_skill_action"]);
    registerMcpTools([makeMcpTool("mcp__example__lookup")]);

    const toolDefs = [
      makeToolDef("bash"),
      makeToolDef("host_bash"),
      makeToolDef("file_read"),
      makeToolDef("skill_load"),
      makeToolDef("file_write"),
      makeToolDef("file_edit"),
      makeToolDef("host_file_write"),
      makeToolDef("host_file_edit"),
      makeToolDef("skill_execute"),
      makeToolDef("web_fetch"),
      makeToolDef("web_search"),
      makeToolDef("ui_show"),
    ];
    const ctx = makeProjectionCtx({ diskPressureCleanupModeActive: true });
    const resolve = createResolveToolsCallback(toolDefs, ctx)!;

    const cleanupTools = resolve([]);
    const cleanupNames = cleanupTools.map((tool) => tool.name).sort();

    expect(cleanupNames).toEqual([
      "bash",
      "file_read",
      "host_bash",
      "skill_load",
    ]);
    expect(ctx.allowedToolNames).toEqual(
      new Set(["bash", "file_read", "host_bash", "skill_load"]),
    );
    // Disk-pressure runtime instructions may direct the assistant to load
    // system-storage-cleanup, so cleanup projection must keep skill_load.
    expect(cleanupNames).toContain("skill_load");
    for (const hiddenName of [
      "file_write",
      "file_edit",
      "host_file_write",
      "host_file_edit",
      "skill_execute",
      "web_fetch",
      "web_search",
      "ui_show",
      "mcp__example__lookup",
      "cleanup_skill_action",
    ]) {
      expect(cleanupNames).not.toContain(hiddenName);
      expect(ctx.allowedToolNames?.has(hiddenName)).toBe(false);
    }

    ctx.diskPressureCleanupModeActive = false;
    const normalTools = resolve([]);
    const normalNames = normalTools.map((tool) => tool.name);

    expect(normalNames).toContain("file_write");
    expect(normalNames).toContain("skill_execute");
    expect(normalNames).toContain("web_fetch");
    expect(normalNames).toContain("ui_show");
    expect(normalNames).toContain("mcp__example__lookup");
    expect(ctx.allowedToolNames?.has("file_write")).toBe(true);
    expect(ctx.allowedToolNames?.has("cleanup_skill_action")).toBe(true);
  });

  test("executor fallback rejects non-cleanup tools even if stale allowlist includes them", async () => {
    const handler = new ToolApprovalHandler();

    async function expectCleanupGateRejects(
      name: string,
      input: Record<string, unknown>,
    ): Promise<void> {
      const result = await handler.checkPreExecutionGates(
        name,
        input,
        {
          workingDir: "/workspace",
          conversationId: "conv-cleanup",
          trustClass: "guardian",
          allowedToolNames: new Set([name]),
          diskPressureCleanupModeActive: true,
        },
        "sandbox",
        "low",
        Date.now(),
        () => undefined,
      );

      expect(result.allowed).toBe(false);
      if (result.allowed) {
        throw new Error("Expected disk pressure cleanup gate to reject tool");
      }
      expect(result.result.content).toContain(
        "not available during disk pressure cleanup mode",
      );
    }

    await expectCleanupGateRejects("file_write", {
      path: "large.log",
      content: "data",
    });
    await expectCleanupGateRejects("skill_execute", {
      tool: "cleanup_skill_action",
      input: {},
    });
  });

  test("executor fallback keeps only instruction-only skill_load safe during cleanup mode", async () => {
    writeManagedSkill(
      "plain-cleanup",
      `---
name: plain-cleanup
description: Plain cleanup
---

This skill is instruction-only but unrelated.
`,
    );
    writeManagedSkill(
      "dynamic-cleanup",
      `---
name: dynamic-cleanup
description: Dynamic cleanup
---

This skill runs !\`echo unsafe\`.
`,
    );
    writeManagedSkill(
      "tool-cleanup",
      `---
name: tool-cleanup
description: Tool cleanup
---

This skill declares executable tools.
`,
      {
        version: 1,
        tools: [
          {
            name: "tool_cleanup_run",
            description: "Run cleanup",
            category: "test",
            risk: "low",
            input_schema: { type: "object", properties: {} },
            executor: "run.ts",
            execution_target: "sandbox",
          },
        ],
      },
    );

    const handler = new ToolApprovalHandler();
    const baseContext = {
      workingDir: "/workspace",
      conversationId: "conv-cleanup",
      trustClass: "guardian" as const,
      allowedToolNames: new Set(["skill_load"]),
      diskPressureCleanupModeActive: true,
    };

    const safeResult = await handler.checkPreExecutionGates(
      "skill_load",
      { skill: "bundled:system-storage-cleanup" },
      baseContext,
      "sandbox",
      "low",
      Date.now(),
      () => undefined,
    );

    expect(safeResult.allowed).toBe(true);
    if (!safeResult.allowed) {
      throw new Error("Expected instruction-only bundled skill_load to pass");
    }
    expect(safeResult.tool.name).toBe("skill_load");

    const dynamicResult = await handler.checkPreExecutionGates(
      "skill_load",
      { skill: "dynamic-cleanup" },
      baseContext,
      "sandbox",
      "low",
      Date.now(),
      () => undefined,
    );

    expect(dynamicResult.allowed).toBe(false);
    if (dynamicResult.allowed) {
      throw new Error("Expected dynamic skill_load to be rejected");
    }
    expect(dynamicResult.result.content).toContain(
      'can only load the bundled "system-storage-cleanup" skill',
    );

    const unrelatedResult = await handler.checkPreExecutionGates(
      "skill_load",
      { skill: "plain-cleanup" },
      baseContext,
      "sandbox",
      "low",
      Date.now(),
      () => undefined,
    );

    expect(unrelatedResult.allowed).toBe(false);
    if (unrelatedResult.allowed) {
      throw new Error(
        "Expected unrelated instruction-only skill to be rejected",
      );
    }
    expect(unrelatedResult.result.content).toContain(
      'can only load the bundled "system-storage-cleanup" skill',
    );

    const toolManifestResult = await handler.checkPreExecutionGates(
      "skill_load",
      { skill: "tool-cleanup" },
      baseContext,
      "sandbox",
      "low",
      Date.now(),
      () => undefined,
    );

    expect(toolManifestResult.allowed).toBe(false);
    if (toolManifestResult.allowed) {
      throw new Error("Expected tool-manifest skill_load to be rejected");
    }
    expect(toolManifestResult.result.content).toContain(
      'can only load the bundled "system-storage-cleanup" skill',
    );

    writeManagedSkill(
      "system-storage-cleanup",
      `---
name: system-storage-cleanup
description: Shadow cleanup
---

This managed skill shadows the bundled cleanup skill.
`,
    );

    const normalShadow = loadSkillBySelector("system-storage-cleanup");
    expect(normalShadow.skill?.source).toBe("managed");

    const bundledShadow = loadSkillBySelector("bundled:system-storage-cleanup");
    expect(bundledShadow.skill?.source).toBe("bundled");

    const shadowResult = await handler.checkPreExecutionGates(
      "skill_load",
      { skill: "system-storage-cleanup" },
      baseContext,
      "sandbox",
      "low",
      Date.now(),
      () => undefined,
    );

    expect(shadowResult.allowed).toBe(false);
    if (shadowResult.allowed) {
      throw new Error("Expected managed shadow cleanup skill to be rejected");
    }
    expect(shadowResult.result.content).toContain(
      'can only load the bundled "system-storage-cleanup" skill',
    );

    const bundledShadowResult = await handler.checkPreExecutionGates(
      "skill_load",
      { skill: "bundled:system-storage-cleanup" },
      baseContext,
      "sandbox",
      "low",
      Date.now(),
      () => undefined,
    );

    expect(bundledShadowResult.allowed).toBe(true);
    if (!bundledShadowResult.allowed) {
      throw new Error("Expected bundled selector to bypass managed shadow");
    }
    expect(bundledShadowResult.tool.name).toBe("skill_load");
  });

  test("locking cancels registered terminal background tools with disk pressure reason", () => {
    const bashCancel = mock((_reason?: string) => undefined);
    const hostCancel = mock((_reason?: string) => undefined);
    const otherCancel = mock((_reason?: string) => undefined);

    registerBackgroundTool({
      id: "bg-bash",
      toolName: "bash",
      conversationId: "conv-1",
      command: "sleep 100",
      startedAt: 1,
      cancel: bashCancel,
    });
    registerBackgroundTool({
      id: "bg-host",
      toolName: "host_bash",
      conversationId: "conv-1",
      command: "sleep 100",
      startedAt: 2,
      cancel: hostCancel,
    });
    registerBackgroundTool({
      id: "bg-other",
      toolName: "web_fetch",
      conversationId: "conv-1",
      command: "fetch",
      startedAt: 3,
      cancel: otherCancel,
    });

    setDiskUsage(DISK_PRESSURE_THRESHOLD_PERCENT);
    const status = evaluateDiskPressureNow();

    expect(status.locked).toBe(true);
    expect(bashCancel).toHaveBeenCalledWith("disk_pressure");
    expect(hostCancel).toHaveBeenCalledWith("disk_pressure");
    expect(otherCancel).not.toHaveBeenCalled();
    expect(listBackgroundTools().map((tool) => tool.id)).toEqual(["bg-other"]);
  });

  test("background shell modes are blocked during cleanup mode", async () => {
    const shellResult = await shellTool.execute(
      {
        command: "sleep 100",
        activity: "check disk usage",
        background: true,
      },
      {
        workingDir: "/workspace",
        conversationId: "conv-cleanup",
        trustClass: "guardian",
        diskPressureCleanupModeActive: true,
      },
    );

    expect(shellResult.isError).toBe(true);
    expect(shellResult.content).toContain(
      "background shell commands are not available",
    );

    const hostResult = await hostShellTool.execute(
      {
        command: "sleep 100",
        activity: "check disk usage",
        background: true,
      },
      {
        workingDir: "/workspace",
        conversationId: "conv-cleanup",
        trustClass: "guardian",
        diskPressureCleanupModeActive: true,
      },
    );

    expect(hostResult.isError).toBe(true);
    expect(hostResult.content).toContain(
      "background host shell commands are not available",
    );
  });
});
