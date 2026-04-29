import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let workspaceDir: string;

// Stub the in-process SSE hub so the writer's publish path is a
// no-op in these tests.
const publishSpy = mock<(event: unknown) => Promise<void>>(async () => {});

mock.module("../../runtime/assistant-event-hub.js", () => ({
  assistantEventHub: {
    publish: publishSpy,
    subscribe: () => () => {},
  },
}));

// Stub workspace prompt reads so the heartbeat service doesn't try to
// read real workspace files. Use a fallback for early module-load calls
// (e.g. AuthSessionCache constructor) before beforeEach sets workspaceDir.
const fallbackDir = join(tmpdir(), "vellum-hb-svc-fallback");
mock.module("../../util/platform.js", () => ({
  getWorkspaceDir: () => workspaceDir ?? fallbackDir,
  getWorkspacePromptPath: (name: string) =>
    join(workspaceDir ?? fallbackDir, name),
  vellumRoot: () => workspaceDir ?? fallbackDir,
  getDataDir: () => join(workspaceDir ?? fallbackDir, "data"),
  getConversationsDir: () => join(workspaceDir ?? fallbackDir, "conversations"),
  isMacOS: () => false,
  isLinux: () => true,
  isWindows: () => false,
  getPlatformName: () => "linux",
  normalizeAssistantId: (id: string) => id,
  getEmbeddingModelsDir: () => join(workspaceDir ?? fallbackDir, "models"),
  getSandboxRootDir: () => join(workspaceDir ?? fallbackDir, "sandbox"),
  getSandboxWorkingDir: () => join(workspaceDir ?? fallbackDir, "sandbox/work"),
  getInterfacesDir: () => join(workspaceDir ?? fallbackDir, "interfaces"),
  getSoundsDir: () => join(workspaceDir ?? fallbackDir, "sounds"),
  getAvatarDir: () => join(workspaceDir ?? fallbackDir, "avatar"),
  AVATAR_IMAGE_FILENAME: "avatar-image.png",
  getAvatarImagePath: () =>
    join(workspaceDir ?? fallbackDir, "avatar/avatar-image.png"),

  getXdgVellumConfigDirName: () => ".vellum",
}));

// Stub config so heartbeat is enabled. Must export every symbol from
// the real module because Bun's mock.module replaces the entire module.
const stubConfig = {
  heartbeat: {
    enabled: true,
    intervalMs: 60_000,
    activeHoursStart: null,
    activeHoursEnd: null,
  },
};
mock.module("../../config/loader.js", () => ({
  getConfig: () => stubConfig,
  getConfigReadOnly: () => stubConfig,
  loadConfig: () => stubConfig,
  saveConfig: () => {},
  invalidateConfigCache: () => {},
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  applyNestedDefaults: (c: unknown) => c,
  deepMergeMissing: (a: unknown) => a,
  deepMergeOverwrite: (a: unknown) => a,
  mergeDefaultWorkspaceConfig: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
  API_KEY_PROVIDERS: [],
  _appendQuarantineBulletin: () => {},
}));

// Stub prompt helpers.
mock.module("../../prompts/persona-resolver.js", () => ({
  GUARDIAN_PERSONA_TEMPLATE: "",
  resolveGuardianPersona: () => null,
  resolveGuardianPersonaPath: () => null,
  resolveGuardianPersonaStrict: () => null,
  isGuardianPersonaCustomized: () => false,
  resolveUserSlug: () => null,
  resolveUserPersona: () => null,
  resolveChannelPersona: () => null,
  resolvePersonaContext: () => ({}),
  ensureGuardianPersonaFile: () => {},
}));
mock.module("../../prompts/system-prompt.js", () => ({
  isTemplateContent: () => false,
  SYSTEM_PROMPT_CACHE_BOUNDARY: "<<CACHE_BOUNDARY>>",
  buildCoreIdentityContext: () => "",
  buildSystemPrompt: () => "",
  buildCliReferenceSection: () => "",
  ensurePromptFiles: () => {},
  stripCommentLines: (s: string) => s,
}));

// Mock runBackgroundJob — HeartbeatService now delegates the
// bootstrap/processMessage/timeout/failure-emit boundary to it.
const STUB_CONVERSATION_ID = "conv-heartbeat-test";

interface RunBackgroundJobCall {
  jobName: string;
  source: string;
  prompt: string;
  trustContext: { sourceChannel: string; trustClass: string };
  callSite: string;
  timeoutMs: number;
  origin: string;
  groupId?: string;
}

const runBackgroundJobCalls: RunBackgroundJobCall[] = [];
let runBackgroundJobImpl: () => Promise<{
  conversationId: string;
  ok: boolean;
  error?: Error;
  errorKind?: string;
}> = async () => ({
  conversationId: STUB_CONVERSATION_ID,
  ok: true,
});

mock.module("../../runtime/background-job-runner.js", () => ({
  runBackgroundJob: async (opts: RunBackgroundJobCall) => {
    runBackgroundJobCalls.push(opts);
    return runBackgroundJobImpl();
  },
}));

// Stub credential health service so the heartbeat doesn't spin up a
// real check during the test.
mock.module("../../credential-health/credential-health-service.js", () => ({
  checkAllCredentials: async () => ({ unhealthy: [] }),
}));

const { HeartbeatService } = await import("../heartbeat-service.js");

let origWorkspaceDir: string | undefined;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-hb-svc-"));
  origWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
  publishSpy.mockClear();
  runBackgroundJobCalls.length = 0;
  runBackgroundJobImpl = async () => ({
    conversationId: STUB_CONVERSATION_ID,
    ok: true,
  });
});

afterEach(() => {
  if (origWorkspaceDir === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = origWorkspaceDir;
  }
  try {
    rmSync(workspaceDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

describe("HeartbeatService", () => {
  test("invokes runBackgroundJob with expected options on each tick", async () => {
    const service = new HeartbeatService({
      alerter: () => {},
    });

    await service.runOnce({ force: true });

    expect(runBackgroundJobCalls).toHaveLength(1);
    const call = runBackgroundJobCalls[0]!;
    expect(call.jobName).toBe("heartbeat");
    expect(call.source).toBe("heartbeat");
    expect(call.callSite).toBe("heartbeatAgent");
    expect(call.origin).toBe("heartbeat");
    expect(call.groupId).toBe("system:background");
    expect(call.timeoutMs).toBeGreaterThan(0);
    expect(call.trustContext).toEqual({
      sourceChannel: "vellum",
      trustClass: "guardian",
    });
    expect(call.prompt).toContain("<heartbeat-checklist>");
    expect(call.prompt).toContain("<heartbeat-disposition>");
  });

  test("fires onConversationCreated with the runner-returned conversationId", async () => {
    const created: Array<{ conversationId: string; title: string }> = [];
    const service = new HeartbeatService({
      alerter: () => {},
      onConversationCreated: (info) => created.push(info),
    });

    await service.runOnce({ force: true });

    expect(created).toEqual([
      { conversationId: STUB_CONVERSATION_ID, title: "Heartbeat" },
    ]);
  });

  test("calls alerter with the failure message when the runner reports ok=false", async () => {
    runBackgroundJobImpl = async () => ({
      conversationId: STUB_CONVERSATION_ID,
      ok: false,
      error: new Error("LLM call failed"),
      errorKind: "exception",
    });

    const alerts: Array<{ type: string; title: string; body: string }> = [];
    const service = new HeartbeatService({
      alerter: (alert) =>
        alerts.push(alert as { type: string; title: string; body: string }),
    });

    await service.runOnce({ force: true });

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      type: "heartbeat_alert",
      title: "Heartbeat Failed",
      body: "LLM call failed",
    });
  });

  test("does not call alerter when the runner reports ok=true", async () => {
    const alerts: unknown[] = [];
    const service = new HeartbeatService({
      alerter: (alert) => alerts.push(alert),
    });

    await service.runOnce({ force: true });

    expect(alerts).toHaveLength(0);
  });
});
