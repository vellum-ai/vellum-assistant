import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "session-attach-test-"));
const workspaceDir = join(testDir, "workspace");

mock.module("../util/platform.js", () => ({
  getDataDir: () => join(workspaceDir, "data"),
  getWorkspaceDir: () => workspaceDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
  getRootDir: () => testDir,
}));

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
    rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
  }),
}));

// Stub out video thumbnail generation (requires ffmpeg)
mock.module("../daemon/video-thumbnail.js", () => ({
  generateVideoThumbnail: () => Promise.resolve(null),
  generateVideoThumbnailFromPath: () => Promise.resolve(null),
}));

// Stub out permission checker / trust store
mock.module("../permissions/checker.js", () => ({
  check: () => Promise.resolve({ decision: "allow" }),
  classifyRisk: () => Promise.resolve("low"),
  generateAllowlistOptions: () => Promise.resolve([]),
  generateScopeOptions: () => [],
}));

mock.module("../permissions/trust-store.js", () => ({
  addRule: () => {},
}));

mock.module("../permissions/types.js", () => ({
  isAllowDecision: () => true,
}));

import type { AssistantAttachmentDraft } from "../daemon/assistant-attachments.js";
import {
  FILE_BACKED_THRESHOLD_BYTES,
  getFilePathForAttachment,
} from "../memory/attachments-store.js";
import { addMessage, createConversation } from "../memory/conversation-crud.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";

initializeDb();

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

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
// resolveAssistantAttachments — inline vs file-backed storage
// ---------------------------------------------------------------------------

describe("resolveAssistantAttachments", () => {
  beforeEach(resetTables);

  test("attachments under 5 MB are stored inline via uploadAttachment", async () => {
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
    expect(emitted.data).toBe(dataBase64); // inline — data is present
    expect(emitted.sizeBytes).toBeUndefined(); // no sizeBytes hint for inline

    // Verify the attachment is in the DB and not file-backed
    const filePath = getFilePathForAttachment(emitted.id!);
    expect(filePath).toBeNull();
  });

  test("attachments over 5 MB are stored via uploadFileBackedAttachment with file on disk", async () => {
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
    // File-backed: data should be empty, sizeBytes should be set
    expect(emitted.data).toBe("");
    expect(emitted.sizeBytes).toBe(largeSize);

    // Verify the file exists on disk at the expected path
    const filePath = getFilePathForAttachment(emitted.id!);
    expect(filePath).not.toBeNull();
    expect(filePath!).toContain("attachments");
    expect(filePath!).toContain("big-video.mov");
    expect(existsSync(filePath!)).toBe(true);
  });
});

describe("FILE_BACKED_THRESHOLD_BYTES", () => {
  test("is 5 MB", () => {
    expect(FILE_BACKED_THRESHOLD_BYTES).toBe(5 * 1024 * 1024);
  });
});
