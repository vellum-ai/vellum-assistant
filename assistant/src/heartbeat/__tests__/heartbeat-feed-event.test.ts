import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

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
// read real workspace files.
mock.module("../../util/platform.js", () => ({
  getWorkspaceDir: () => workspaceDir,
  getWorkspacePromptPath: (name: string) => join(workspaceDir, name),
  vellumRoot: () => workspaceDir,
}));

// Stub config so heartbeat is enabled.
mock.module("../../config/loader.js", () => ({
  getConfig: () => ({
    heartbeat: {
      enabled: true,
      intervalMs: 60_000,
      activeHoursStart: null,
      activeHoursEnd: null,
    },
  }),
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
}));
mock.module("../../prompts/system-prompt.js", () => ({
  isTemplateContent: () => false,
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

let workspaceDir: string;
let origWorkspaceDir: string | undefined;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-hb-feed-"));
  origWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
  publishSpy.mockClear();
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
    const service = new HeartbeatService({
      processMessage: async () => ({ messageId: "msg-1" }),
      alerter: () => {},
    });

    await service.runOnce({ force: true });

    // Give the fire-and-forget emitFeedEvent time to flush.
    await new Promise((r) => setTimeout(r, 100));

    const items = readFeedItems();
    const heartbeatItem = items.find((i) => i.title === "Heartbeat");
    expect(heartbeatItem).toBeDefined();
    expect(heartbeatItem!.summary).toBe("All systems healthy.");
    expect(heartbeatItem!.priority).toBe(30);
    expect(heartbeatItem!.urgency).toBeUndefined();
    expect(heartbeatItem!.source).toBe("assistant");
  });

  test("failed heartbeat emits feed event with priority 55 and urgency medium", async () => {
    const service = new HeartbeatService({
      processMessage: async () => {
        throw new Error("LLM call failed");
      },
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
    const service = new HeartbeatService({
      processMessage: async () => ({ messageId: "msg-1" }),
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
    expect(heartbeatItems[0]!.id).toBe(`emit:assistant:heartbeat:${today}`);
  });
});
