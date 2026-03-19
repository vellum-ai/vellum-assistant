import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "attach-store-test-"));

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
  getRootDir: () => testDir,
  getWorkspaceDir: () => join(testDir, "workspace"),
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
    rateLimit: { maxRequestsPerMinute: 0 },
  }),
}));

import {
  AttachmentUploadError,
  deleteAttachment,
  deleteOrphanAttachments,
  getAttachmentById,
  getAttachmentContent,
  getAttachmentsByIds,
  getAttachmentsForMessage,
  getFilePathForAttachment,
  isValidBase64,
  linkAttachmentToMessage,
  MAX_UPLOAD_BYTES,
  uploadAttachment,
  validateAttachmentUpload,
} from "../memory/attachments-store.js";
import { addMessage, createConversation } from "../memory/conversation-crud.js";
import { getDb, initializeDb, rawGet, resetDb } from "../memory/db.js";

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

// ---------------------------------------------------------------------------
// uploadAttachment — always writes to disk
// ---------------------------------------------------------------------------

describe("uploadAttachment", () => {
  beforeEach(resetTables);

  test("stores attachment and returns metadata", () => {
    const stored = uploadAttachment("chart.png", "image/png", "iVBORw0K");

    expect(stored.id).toBeDefined();
    expect(stored.originalFilename).toBe("chart.png");
    expect(stored.mimeType).toBe("image/png");
    expect(stored.kind).toBe("image");
    expect(stored.sizeBytes).toBeGreaterThan(0);
    expect(stored.createdAt).toBeGreaterThan(0);
  });

  test("always writes file to disk", () => {
    const stored = uploadAttachment("small.txt", "text/plain", "aGVsbG8=");
    const filePath = getFilePathForAttachment(stored.id);

    expect(filePath).toBeTruthy();
    expect(existsSync(filePath!)).toBe(true);

    // The on-disk file should contain the decoded bytes
    const content = readFileSync(filePath!);
    expect(content.toString()).toBe("hello");
  });

  test("stores empty dataBase64 in DB row but hydrates on read", () => {
    const stored = uploadAttachment("test.txt", "text/plain", "dGVzdA==");

    // The raw DB row stores empty dataBase64 since content is on disk
    const rawRow = rawGet<{ data_base64: string }>(
      "SELECT data_base64 FROM attachments WHERE id = ?",
      stored.id,
    );
    expect(rawRow!.data_base64).toBe("");

    // But getAttachmentById hydrates from disk
    const row = getAttachmentById(stored.id, { hydrateFileData: true });
    expect(row).not.toBeNull();
    expect(row!.dataBase64).toBe("dGVzdA==");
  });

  test("classifies image MIME as image kind", () => {
    const stored = uploadAttachment("pic.jpg", "image/jpeg", "AAAA");
    expect(stored.kind).toBe("image");
  });

  test("classifies non-image MIME as document kind", () => {
    const stored = uploadAttachment("doc.pdf", "application/pdf", "JVBER");
    expect(stored.kind).toBe("document");
  });

  test("generates unique IDs for each upload", () => {
    const a = uploadAttachment("a.txt", "text/plain", "AA==");
    const b = uploadAttachment("b.txt", "text/plain", "QQ==");
    expect(a.id).not.toBe(b.id);
  });

  test("computes sizeBytes from base64 correctly", () => {
    // "hello" = "aGVsbG8=" (8 chars, 1 pad -> 5 bytes)
    const stored = uploadAttachment("hello.txt", "text/plain", "aGVsbG8=");
    expect(stored.sizeBytes).toBe(5);
  });

  test("deduplicates by content hash", () => {
    const first = uploadAttachment(
      "photo.png",
      "image/png",
      "iVBORw0KGgoAAAANSUh",
    );
    const second = uploadAttachment(
      "photo.png",
      "image/png",
      "iVBORw0KGgoAAAANSUh",
    );
    expect(second.id).toBe(first.id);
  });

  test("deduplicates even when filenames differ", () => {
    const first = uploadAttachment(
      "original.png",
      "image/png",
      "DUPECONTENT123",
    );
    const second = uploadAttachment(
      "renamed.png",
      "image/png",
      "DUPECONTENT123",
    );
    expect(second.id).toBe(first.id);
  });

  test("does not deduplicate different content", () => {
    const first = uploadAttachment("a.txt", "text/plain", "CONTENTA");
    const second = uploadAttachment("b.txt", "text/plain", "CONTENTB");
    expect(second.id).not.toBe(first.id);
  });

  test("rejects payloads exceeding MAX_UPLOAD_BYTES", () => {
    // Build a base64 string that decodes to just over the limit.
    // 4 base64 chars -> 3 bytes, so we need ceil((MAX_UPLOAD_BYTES+1)/3)*4 chars.
    const oversizedLength = Math.ceil((MAX_UPLOAD_BYTES + 1) / 3) * 4;
    const oversizedData = "A".repeat(oversizedLength);

    expect(() =>
      uploadAttachment("huge.bin", "application/octet-stream", oversizedData),
    ).toThrow(AttachmentUploadError);
  });

  test("rejects invalid base64 data", () => {
    expect(() =>
      uploadAttachment("bad.txt", "text/plain", "!!!not-base64!!!"),
    ).toThrow(AttachmentUploadError);
  });

  test("accepts base64 with non-standard padding/length", () => {
    // Lenient on length -- only character set is validated
    expect(() => uploadAttachment("ok.txt", "text/plain", "AAA")).not.toThrow();
  });

  test("accepts payload exactly at MAX_UPLOAD_BYTES", () => {
    // MAX_UPLOAD_BYTES (100 MB) is divisible by 3, so (MAX/3)*4 base64 chars
    // decodes to exactly MAX bytes with no padding.
    const exactLength = (MAX_UPLOAD_BYTES / 3) * 4;
    const exactData = "A".repeat(exactLength);

    expect(() =>
      uploadAttachment("exact.bin", "application/octet-stream", exactData),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// getAttachmentContent — always reads from disk
// ---------------------------------------------------------------------------

describe("getAttachmentContent", () => {
  beforeEach(resetTables);

  test("reads content from on-disk file", () => {
    const stored = uploadAttachment("hello.txt", "text/plain", "aGVsbG8=");
    const content = getAttachmentContent(stored.id);

    expect(content).not.toBeNull();
    expect(content!.toString()).toBe("hello");
  });

  test("returns null for nonexistent attachment", () => {
    const content = getAttachmentContent("no-such-id");
    expect(content).toBeNull();
  });

  test("returns null when on-disk file is missing (ENOENT)", () => {
    const stored = uploadAttachment("test.txt", "text/plain", "dGVzdA==");
    const filePath = getFilePathForAttachment(stored.id);

    // Remove the file to simulate ENOENT
    rmSync(filePath!);

    const content = getAttachmentContent(stored.id);
    expect(content).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isValidBase64
// ---------------------------------------------------------------------------

describe("isValidBase64", () => {
  test("accepts valid base64 strings", () => {
    expect(isValidBase64("aGVsbG8=")).toBe(true); // "hello"
    expect(isValidBase64("dGVzdA==")).toBe(true); // "test"
    expect(isValidBase64("AAAA")).toBe(true); // no padding
    expect(isValidBase64("")).toBe(true); // empty
  });

  test("accepts strings with non-standard length (lenient)", () => {
    expect(isValidBase64("AAA")).toBe(true); // 3 chars, OK
    expect(isValidBase64("AAAAA")).toBe(true); // 5 chars, OK
  });

  test("rejects strings with invalid characters", () => {
    expect(isValidBase64("!!!!")).toBe(false);
    expect(isValidBase64("abc@")).toBe(false);
    expect(isValidBase64("hello world")).toBe(false); // space
    expect(isValidBase64("data_here")).toBe(false); // underscore
  });
});

// ---------------------------------------------------------------------------
// deleteAttachment
// ---------------------------------------------------------------------------

describe("deleteAttachment", () => {
  beforeEach(resetTables);

  test("deletes existing attachment and returns deleted", () => {
    const stored = uploadAttachment("file.txt", "text/plain", "dGVzdA==");
    const result = deleteAttachment(stored.id);
    expect(result).toBe("deleted");

    const fetched = getAttachmentById(stored.id);
    expect(fetched).toBeNull();
  });

  test("cleans up on-disk file when deleting", () => {
    const stored = uploadAttachment("cleanup.txt", "text/plain", "dGVzdA==");
    const filePath = getFilePathForAttachment(stored.id);
    expect(existsSync(filePath!)).toBe(true);

    deleteAttachment(stored.id);
    expect(existsSync(filePath!)).toBe(false);
  });

  test("returns not_found for nonexistent attachment", () => {
    const result = deleteAttachment("nonexistent-id");
    expect(result).toBe("not_found");
  });

  test("returns still_referenced when messages reference the attachment", async () => {
    const conv = createConversation();
    const msg1 = await addMessage(conv.id, "user", "First upload");
    const msg2 = await addMessage(conv.id, "user", "Duplicate upload");

    // Dedup: both uploads return the same attachment row
    const first = uploadAttachment("photo.png", "image/png", "SHAREDCONTENT1");
    const second = uploadAttachment("photo.png", "image/png", "SHAREDCONTENT1");
    expect(second.id).toBe(first.id);

    linkAttachmentToMessage(msg1.id, first.id, 0);
    linkAttachmentToMessage(msg2.id, second.id, 0);

    // Delete should return still_referenced and NOT remove the attachment row
    const result = deleteAttachment(first.id);
    expect(result).toBe("still_referenced");

    // Attachment row still exists because messages reference it
    const fetched = getAttachmentById(first.id);
    expect(fetched).not.toBeNull();

    // Both messages still see the attachment
    const linked1 = getAttachmentsForMessage(msg1.id);
    expect(linked1).toHaveLength(1);
    const linked2 = getAttachmentsForMessage(msg2.id);
    expect(linked2).toHaveLength(1);
  });

  test("deletes attachment when no messages reference it", () => {
    const stored = uploadAttachment("lonely.txt", "text/plain", "UNREFERENCED");
    // No linkAttachmentToMessage call -- zero references
    const result = deleteAttachment(stored.id);
    expect(result).toBe("deleted");

    const fetched = getAttachmentById(stored.id);
    expect(fetched).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getAttachmentsByIds
// ---------------------------------------------------------------------------

describe("getAttachmentsByIds", () => {
  beforeEach(resetTables);

  test("returns matching attachments with hydrated dataBase64", () => {
    const a = uploadAttachment("a.txt", "text/plain", "AAAA");
    const b = uploadAttachment("b.txt", "text/plain", "BBBB");

    const results = getAttachmentsByIds([a.id, b.id], { hydrateFileData: true });
    expect(results).toHaveLength(2);
    // dataBase64 is hydrated from on-disk files
    expect(results[0].dataBase64).toBe("AAAA");
    expect(results[1].dataBase64).toBe("BBBB");
  });

  test("returns empty array for empty IDs list", () => {
    const results = getAttachmentsByIds([]);
    expect(results).toHaveLength(0);
  });

  test("skips IDs that do not exist", () => {
    const a = uploadAttachment("a.txt", "text/plain", "AAAA");
    const results = getAttachmentsByIds([a.id, "nonexistent"]);
    expect(results).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// getAttachmentById
// ---------------------------------------------------------------------------

describe("getAttachmentById", () => {
  beforeEach(resetTables);

  test("returns attachment with hydrated dataBase64 when found", () => {
    const stored = uploadAttachment("report.pdf", "application/pdf", "JVBER");
    const result = getAttachmentById(stored.id, { hydrateFileData: true });

    expect(result).not.toBeNull();
    expect(result!.id).toBe(stored.id);
    expect(result!.originalFilename).toBe("report.pdf");
    // dataBase64 is hydrated from on-disk file (round-trips via binary)
    expect(result!.dataBase64).toBe("JVBE");
  });

  test("returns null for nonexistent ID", () => {
    const result = getAttachmentById("no-such-id");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// linkAttachmentToMessage + getAttachmentsForMessage
// ---------------------------------------------------------------------------

describe("linkAttachmentToMessage + getAttachmentsForMessage", () => {
  beforeEach(resetTables);

  test("links attachment and retrieves it by message", async () => {
    const conv = createConversation();
    const msg = await addMessage(conv.id, "assistant", "Here is a chart");
    const stored = uploadAttachment("chart.png", "image/png", "iVBORw0K");

    linkAttachmentToMessage(msg.id, stored.id, 0);

    const linked = getAttachmentsForMessage(msg.id);
    expect(linked).toHaveLength(1);
    expect(linked[0].id).toBe(stored.id);
    expect(linked[0].originalFilename).toBe("chart.png");
    // dataBase64 is hydrated from on-disk file
    expect(linked[0].dataBase64).toBe("iVBORw0K");
  });

  test("returns attachments in position order", async () => {
    const conv = createConversation();
    const msg = await addMessage(conv.id, "assistant", "Multiple files");
    const a = uploadAttachment("first.txt", "text/plain", "AAAA");
    const b = uploadAttachment("second.txt", "text/plain", "BBBB");

    // Link in reverse order
    linkAttachmentToMessage(msg.id, b.id, 1);
    linkAttachmentToMessage(msg.id, a.id, 0);

    const linked = getAttachmentsForMessage(msg.id);
    expect(linked).toHaveLength(2);
    expect(linked[0].originalFilename).toBe("first.txt");
    expect(linked[1].originalFilename).toBe("second.txt");
  });

  test("returns empty for message with no attachments", async () => {
    const conv = createConversation();
    const msg = await addMessage(conv.id, "assistant", "No attachments");

    const linked = getAttachmentsForMessage(msg.id);
    expect(linked).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// deleteOrphanAttachments
// ---------------------------------------------------------------------------

describe("deleteOrphanAttachments", () => {
  beforeEach(resetTables);

  test("removes candidate attachments with no message links", () => {
    const stored = uploadAttachment("orphan.txt", "text/plain", "ZGF0YQ==");

    const removed = deleteOrphanAttachments([stored.id]);
    expect(removed).toBe(1);
  });

  test("cleans up on-disk files when removing orphans", () => {
    const stored = uploadAttachment("orphan.txt", "text/plain", "ZGF0YQ==");
    const filePath = getFilePathForAttachment(stored.id);
    expect(existsSync(filePath!)).toBe(true);

    deleteOrphanAttachments([stored.id]);
    expect(existsSync(filePath!)).toBe(false);
  });

  test("preserves attachments that are still linked", async () => {
    const conv = createConversation();
    const msg = await addMessage(conv.id, "assistant", "With attachment");
    const stored = uploadAttachment("linked.txt", "text/plain", "ZGF0YQ==");
    linkAttachmentToMessage(msg.id, stored.id, 0);

    const removed = deleteOrphanAttachments([stored.id]);
    expect(removed).toBe(0);

    const fetched = getAttachmentById(stored.id);
    expect(fetched).not.toBeNull();
  });

  test("removes only orphans when mixed candidates provided", async () => {
    const conv = createConversation();
    const msg = await addMessage(conv.id, "assistant", "Mixed");
    const linked = uploadAttachment("linked.txt", "text/plain", "AAAA");
    const orphan = uploadAttachment("orphan.txt", "text/plain", "BBBB");
    linkAttachmentToMessage(msg.id, linked.id, 0);

    const removed = deleteOrphanAttachments([linked.id, orphan.id]);
    expect(removed).toBe(1);

    const remaining = getAttachmentById(linked.id);
    expect(remaining).not.toBeNull();
  });

  test("returns 0 when no candidates provided", () => {
    const removed = deleteOrphanAttachments([]);
    expect(removed).toBe(0);
  });

  test("does not delete attachments outside the candidate set", () => {
    const unrelated = uploadAttachment("unrelated.txt", "text/plain", "AAAA");
    const candidate = uploadAttachment("candidate.txt", "text/plain", "BBBB");

    const removed = deleteOrphanAttachments([candidate.id]);
    expect(removed).toBe(1);

    // The unrelated attachment should still exist
    const fetched = getAttachmentById(unrelated.id);
    expect(fetched).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validateAttachmentUpload
// ---------------------------------------------------------------------------

describe("validateAttachmentUpload", () => {
  test("accepts common image MIME types", () => {
    expect(validateAttachmentUpload("photo.png", "image/png").ok).toBe(true);
    expect(validateAttachmentUpload("pic.jpg", "image/jpeg").ok).toBe(true);
    expect(validateAttachmentUpload("anim.gif", "image/gif").ok).toBe(true);
    expect(validateAttachmentUpload("sticker.webp", "image/webp").ok).toBe(
      true,
    );
  });

  test("accepts document MIME types", () => {
    expect(validateAttachmentUpload("doc.pdf", "application/pdf").ok).toBe(
      true,
    );
    expect(validateAttachmentUpload("notes.txt", "text/plain").ok).toBe(true);
    expect(validateAttachmentUpload("data.csv", "text/csv").ok).toBe(true);
    expect(validateAttachmentUpload("config.json", "application/json").ok).toBe(
      true,
    );
  });

  test("accepts audio and video MIME types", () => {
    expect(validateAttachmentUpload("voice.ogg", "audio/ogg").ok).toBe(true);
    expect(validateAttachmentUpload("song.mp3", "audio/mpeg").ok).toBe(true);
    expect(validateAttachmentUpload("clip.mp4", "video/mp4").ok).toBe(true);
  });

  test("accepts application/octet-stream fallback", () => {
    expect(
      validateAttachmentUpload("data.bin", "application/octet-stream").ok,
    ).toBe(true);
  });

  test("rejects dangerous file extensions", () => {
    const exeResult = validateAttachmentUpload(
      "malware.exe",
      "application/octet-stream",
    );
    expect(exeResult.ok).toBe(false);
    if (!exeResult.ok) expect(exeResult.error).toContain(".exe");

    const shResult = validateAttachmentUpload("script.sh", "text/plain");
    expect(shResult.ok).toBe(false);
    if (!shResult.ok) expect(shResult.error).toContain(".sh");

    const isoResult = validateAttachmentUpload(
      "disk.iso",
      "application/octet-stream",
    );
    expect(isoResult.ok).toBe(false);
    if (!isoResult.ok) expect(isoResult.error).toContain(".iso");
  });

  test("rejects dangerous extensions regardless of claimed MIME type", () => {
    // .exe disguised as image/png
    const result = validateAttachmentUpload("payload.exe", "image/png");
    expect(result.ok).toBe(false);
  });

  test("extension check is case-insensitive", () => {
    expect(
      validateAttachmentUpload("PROGRAM.EXE", "application/octet-stream").ok,
    ).toBe(false);
    expect(validateAttachmentUpload("script.SH", "text/plain").ok).toBe(false);
  });

  test("rejects unsupported MIME types", () => {
    const result = validateAttachmentUpload(
      "file.unknown",
      "application/x-msdownload",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Unsupported MIME type");
  });

  test("handles filenames without extensions", () => {
    // No extension -- only MIME check applies
    expect(validateAttachmentUpload("Makefile", "text/plain").ok).toBe(true);
    expect(validateAttachmentUpload("Makefile", "application/x-evil").ok).toBe(
      false,
    );
  });

  test("rejects all dangerous extension variants", () => {
    for (const ext of [
      "bat",
      "cmd",
      "com",
      "msi",
      "dmg",
      "app",
      "scr",
      "pif",
      "vbs",
      "ps1",
      "jar",
    ]) {
      const result = validateAttachmentUpload(
        `file.${ext}`,
        "application/octet-stream",
      );
      expect(result.ok).toBe(false);
    }
  });
});
