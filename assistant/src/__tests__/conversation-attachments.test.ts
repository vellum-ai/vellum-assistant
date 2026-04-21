import { existsSync } from "node:fs";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { _setOverridesForTesting } from "../config/assistant-feature-flags.js";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
  }),
}));

// Stub out video thumbnail generation (requires ffmpeg)
mock.module("../daemon/video-thumbnail.js", () => ({
  generateVideoThumbnail: () => Promise.resolve(null),
  generateVideoThumbnailFromPath: () => Promise.resolve(null),
}));

// Stub out permission checker / trust store
const checkSpy = mock(() => Promise.resolve({ decision: "allow" }));
const addRuleSpy = mock(() => {});

mock.module("../permissions/checker.js", () => ({
  check: checkSpy,
  classifyRisk: () => Promise.resolve({ level: "low" }),
  generateAllowlistOptions: () => Promise.resolve([]),
  generateScopeOptions: () => [],
}));

mock.module("../permissions/trust-store.js", () => ({
  addRule: addRuleSpy,
}));

mock.module("../permissions/types.js", () => ({
  RiskLevel: {
    Low: "low",
    Medium: "medium",
    High: "high",
  },
  isAllowDecision: () => true,
}));

import type { AssistantAttachmentDraft } from "../daemon/assistant-attachments.js";
import { getFilePathForAttachment } from "../memory/attachments-store.js";
import {
  addMessage,
  createConversation,
  updateConversationHostAccess,
} from "../memory/conversation-crud.js";
import { getDb, initializeDb } from "../memory/db.js";

initializeDb();

function resetTables() {
  const db = getDb();
  db.run("DELETE FROM message_attachments");
  db.run("DELETE FROM attachments");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

/**
 * Create a base64 string of approximately `bytes` decoded size.
 */
function makeBase64(bytes: number): string {
  const buf = Buffer.alloc(bytes, 0x41); // fill with 'A'
  return buf.toString("base64");
}

// ---------------------------------------------------------------------------
// resolveAssistantAttachments — all attachments are now file-backed
// ---------------------------------------------------------------------------

describe("resolveAssistantAttachments", () => {
  beforeEach(() => {
    resetTables();
    _setOverridesForTesting({});
    checkSpy.mockClear();
    addRuleSpy.mockClear();
  });

  test("small attachments are stored on disk via uploadAttachment", async () => {
    const conv = createConversation("test-conv");
    const msg = await addMessage(conv.id, "assistant", "hello");

    const smallSize = 2 * 1024 * 1024; // 2 MB
    const dataBase64 = makeBase64(smallSize);

    const draft: AssistantAttachmentDraft = {
      sourceType: "sandbox_file",
      filename: "small-image.png",
      mimeType: "image/png",
      dataBase64,
      sizeBytes: smallSize,
      kind: "image",
    };

    mock.module("../daemon/assistant-attachments.js", () => ({
      resolveDirectives: () =>
        Promise.resolve({ drafts: [draft], warnings: [] }),
      contentBlocksToDrafts: () => [],
      deduplicateDrafts: (d: AssistantAttachmentDraft[]) => d,
      validateDrafts: (d: AssistantAttachmentDraft[]) => ({
        accepted: d,
        warnings: [],
      }),
    }));

    // Re-import to pick up mocks
    const { resolveAssistantAttachments: resolve } =
      await import("../daemon/conversation-attachments.js");

    const result = await resolve(
      [
        {
          source: "sandbox" as const,
          path: "/fake",
          filename: "small-image.png",
          mimeType: "image/png",
        },
      ],
      [],
      [],
      "/tmp",
      async () => true,
      msg.id,
    );

    expect(result.emittedAttachments.length).toBe(1);
    const emitted = result.emittedAttachments[0];
    expect(emitted.id).toBeDefined();

    // All attachments are file-backed and have a file on disk
    const filePath = getFilePathForAttachment(emitted.id!);
    expect(filePath).not.toBeNull();
    expect(existsSync(filePath!)).toBe(true);

    // fileBacked flag is always true now
    expect(emitted.fileBacked).toBe(true);
  });

  test("large attachments are stored on disk with file path", async () => {
    const conv = createConversation("test-conv-large");
    const msg = await addMessage(conv.id, "assistant", "hello");

    const largeSize = 10 * 1024 * 1024; // 10 MB
    const dataBase64 = makeBase64(largeSize);

    const draft: AssistantAttachmentDraft = {
      sourceType: "sandbox_file",
      filename: "big-video.mov",
      mimeType: "video/quicktime",
      dataBase64,
      sizeBytes: largeSize,
      kind: "video",
    };

    mock.module("../daemon/assistant-attachments.js", () => ({
      resolveDirectives: () =>
        Promise.resolve({ drafts: [draft], warnings: [] }),
      contentBlocksToDrafts: () => [],
      deduplicateDrafts: (d: AssistantAttachmentDraft[]) => d,
      validateDrafts: (d: AssistantAttachmentDraft[]) => ({
        accepted: d,
        warnings: [],
      }),
    }));

    const { resolveAssistantAttachments: resolve } =
      await import("../daemon/conversation-attachments.js");

    const result = await resolve(
      [
        {
          source: "sandbox" as const,
          path: "/fake",
          filename: "big-video.mov",
          mimeType: "video/quicktime",
        },
      ],
      [],
      [],
      "/tmp",
      async () => true,
      msg.id,
    );

    expect(result.emittedAttachments.length).toBe(1);
    const emitted = result.emittedAttachments[0];
    expect(emitted.id).toBeDefined();

    // Verify the file exists on disk at the expected path
    const filePath = getFilePathForAttachment(emitted.id!);
    expect(filePath).not.toBeNull();
    expect(filePath!).toContain("attachments");
    expect(filePath!).toContain("big-video.mov");
    expect(existsSync(filePath!)).toBe(true);

    // fileBacked flag is always true now
    expect(emitted.fileBacked).toBe(true);
  });
});

describe("approveHostAttachmentRead", () => {
  beforeEach(() => {
    resetTables();
    _setOverridesForTesting({});
    checkSpy.mockClear();
    addRuleSpy.mockClear();
  });

  test("uses the conversation-scoped host-access prompt under v2", async () => {
    _setOverridesForTesting({ "permission-controls-v2": true });
    const conversation = createConversation("attachment-host-gate");
    const promptSpy = mock(() =>
      Promise.resolve({ decision: "allow" as const }),
    );

    const { approveHostAttachmentRead } =
      await import("../daemon/conversation-attachments.js");

    const allowed = await approveHostAttachmentRead(
      "/tmp/example.txt",
      "/tmp",
      { prompt: promptSpy } as never,
      conversation.id,
      false,
    );

    expect(allowed).toBe(true);
    expect(checkSpy).not.toHaveBeenCalled();
    expect(addRuleSpy).not.toHaveBeenCalled();
    const call = promptSpy.mock.calls[0] as unknown as unknown[];
    expect(call[3]).toEqual([]);
    expect(call[4]).toEqual([]);
    expect(call[8]).toBe(false);
    expect(call[10]).toBeUndefined();
    expect(call[12]).toBe(true);
  });

  test("auto-allows host attachment reads when the conversation already has host access", async () => {
    _setOverridesForTesting({ "permission-controls-v2": true });
    const conversation = createConversation("attachment-host-allowed");
    updateConversationHostAccess(conversation.id, true);
    const promptSpy = mock(() =>
      Promise.resolve({ decision: "deny" as const }),
    );

    const { approveHostAttachmentRead } =
      await import("../daemon/conversation-attachments.js");

    const allowed = await approveHostAttachmentRead(
      "/tmp/example.txt",
      "/tmp",
      { prompt: promptSpy } as never,
      conversation.id,
      false,
    );

    expect(allowed).toBe(true);
    expect(promptSpy).not.toHaveBeenCalled();
    expect(checkSpy).not.toHaveBeenCalled();
  });
});
