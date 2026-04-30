import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  broadcastMessage: () => {},
}));

// Stub workspace prompt reads so the heartbeat service doesn't try to
// read real workspace files. Use a fallback for early module-load calls
// (e.g. AuthSessionCache constructor) before beforeEach sets workspaceDir.
const fallbackDir = join(tmpdir(), "vellum-hb-feed-fallback");
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

// Stub conversation bootstrap.
const lastConversationId = "conv-heartbeat-test";
mock.module("../../memory/conversation-bootstrap.js", () => ({
  bootstrapConversation: () => ({ id: lastConversationId }),
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
  readPromptFile: () => null,
}));

// Mock processMessage — HeartbeatService now imports it directly.
let _testProcessMessage:
  | ((...args: unknown[]) => Promise<{ messageId: string }>)
  | undefined;

mock.module("../../daemon/process-message.js", () => ({
  processMessage: async (...args: unknown[]) => {
    if (_testProcessMessage) return _testProcessMessage(...args);
    return { messageId: `mock-msg-${Date.now()}` };
  },
  processMessageInBackground: async () => ({ messageId: "mock-bg" }),
  resolveTurnChannel: () => "vellum",
  resolveTurnInterface: () => "vellum",
  prepareConversationForMessage: async () => ({}),
}));

const { getHomeFeedPath } = await import("../../home/feed-writer.js");
const { HeartbeatService } = await import("../heartbeat-service.js");

interface OnDiskItem {
  id: string;
  type: string;
  source?: string;
  title: string;
  summary: string;
  priority: number;
  status: string;
  author: string;
  urgency?: string;
}

function readFeedItems(): OnDiskItem[] {
  const raw = JSON.parse(readFileSync(getHomeFeedPath(), "utf-8"));
  return raw.items as OnDiskItem[];
}

let origWorkspaceDir: string | undefined;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-hb-feed-"));
  origWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
  publishSpy.mockClear();
  _testProcessMessage = undefined;
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

describe("heartbeat feed events", () => {
  test("successful heartbeat emits feed event with priority 30 and no urgency", async () => {
    _testProcessMessage = async () => ({ messageId: "msg-1" });
    const service = new HeartbeatService({
      alerter: () => {},
    });

    await service.runOnce({ force: true });

    // Give the fire-and-forget emitFeedEvent time to flush.
    await new Promise((r) => setTimeout(r, 100));

    const items = readFeedItems();
    const heartbeatItem = items.find((i) => i.title === "Heartbeat");
    expect(heartbeatItem).toBeDefined();
    expect(heartbeatItem!.summary).toBe(
      "Periodic check completed. Tap to see details.",
    );
    expect(heartbeatItem!.priority).toBe(30);
    expect(heartbeatItem!.urgency).toBeUndefined();
    expect(heartbeatItem!.source).toBe("assistant");
  });

  test("failed heartbeat emits feed event with priority 55 and urgency medium", async () => {
    _testProcessMessage = async () => {
      throw new Error("LLM call failed");
    };
    const service = new HeartbeatService({
      alerter: () => {},
    });

    await service.runOnce({ force: true });

    // Give the fire-and-forget emitFeedEvent time to flush.
    await new Promise((r) => setTimeout(r, 100));

    const items = readFeedItems();
    const heartbeatItem = items.find((i) => i.title === "Heartbeat");
    expect(heartbeatItem).toBeDefined();
    expect(heartbeatItem!.summary).toBe(
      "Heartbeat check failed. Check logs for details.",
    );
    expect(heartbeatItem!.priority).toBe(55);
    expect(heartbeatItem!.urgency).toBe("medium");
    expect(heartbeatItem!.source).toBe("assistant");
  });

  test("dedupKey uses date for daily dedup", async () => {
    _testProcessMessage = async () => ({ messageId: "msg-1" });
    const service = new HeartbeatService({
      alerter: () => {},
    });

    // Run twice — same day should dedup to one item.
    await service.runOnce({ force: true });
    await new Promise((r) => setTimeout(r, 100));
    await service.runOnce({ force: true });
    await new Promise((r) => setTimeout(r, 100));

    const items = readFeedItems();
    const heartbeatItems = items.filter((i) => i.title === "Heartbeat");
    expect(heartbeatItems).toHaveLength(1);

    const today = new Date().toISOString().split("T")[0];
    expect(heartbeatItems[0]!.id).toBe(`emit:assistant:heartbeat:ok:${today}`);
  });
});
