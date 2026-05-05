import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { SkillProjectionCache } from "../daemon/conversation-skill-tools.js";
import type { SkillProjectionContext } from "../daemon/conversation-tool-setup.js";
import type { Message, ToolDefinition } from "../providers/types.js";
import type { DiskUsageInfo } from "../util/disk-usage.js";

let diskSample: DiskUsageInfo | null = null;

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
    allowedToolNames: new Set<string>(),
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
const {
  _clearRegistryForTesting,
  listBackgroundTools,
  registerBackgroundTool,
} = await import("../tools/background-tool-registry.js");
const { shellTool } = await import("../tools/terminal/shell.js");
const { hostShellTool } = await import("../tools/host-terminal/host-shell.js");

function makeToolDef(name: string): ToolDefinition {
  return { name, description: `${name} tool`, input_schema: {} };
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

beforeEach(() => {
  _clearRegistryForTesting();
  __resetDiskPressureGuardForTests();
  _setOverridesForTesting({ "safe-storage-limits": true });
  setDiskUsage(10);
});

afterEach(() => {
  _clearRegistryForTesting();
  __resetDiskPressureGuardForTests();
  _setOverridesForTesting({});
  diskSample = null;
});

describe("disk pressure cleanup tool restrictions", () => {
  test("cleanup mode hides non-allowlisted tools and restores normal tools after the turn", () => {
    const toolDefs = [
      makeToolDef("bash"),
      makeToolDef("host_bash"),
      makeToolDef("file_read"),
      makeToolDef("file_write"),
      makeToolDef("skill_execute"),
      makeToolDef("web_fetch"),
    ];
    const ctx = makeProjectionCtx({ diskPressureCleanupModeActive: true });
    const resolve = createResolveToolsCallback(toolDefs, ctx)!;

    const cleanupTools = resolve([]);
    const cleanupNames = cleanupTools.map((tool) => tool.name).sort();

    expect(cleanupNames).toEqual(["bash", "file_read", "host_bash"]);
    expect(ctx.allowedToolNames?.has("bash")).toBe(true);
    expect(ctx.allowedToolNames?.has("file_write")).toBe(false);
    expect(ctx.allowedToolNames?.has("skill_execute")).toBe(false);

    ctx.diskPressureCleanupModeActive = false;
    const normalTools = resolve([]);
    const normalNames = normalTools.map((tool) => tool.name);

    expect(normalNames).toContain("file_write");
    expect(normalNames).toContain("skill_execute");
    expect(normalNames).toContain("web_fetch");
    expect(ctx.allowedToolNames?.has("file_write")).toBe(true);
  });

  test("executor fallback rejects non-cleanup tools even if stale allowlist includes them", async () => {
    const handler = new ToolApprovalHandler();
    const result = await handler.checkPreExecutionGates(
      "file_write",
      { path: "large.log", content: "data" },
      {
        workingDir: "/workspace",
        conversationId: "conv-cleanup",
        trustClass: "guardian",
        allowedToolNames: new Set(["file_write"]),
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
