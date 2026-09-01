/**
 * The camera-frame storage sweep.
 *
 * Frames are the one attachment nobody chose to send: the camera samples them
 * every few seconds for as long as a call keeps it up, and each one is a
 * full-resolution image that outlives the call. The sweep shrinks the aged ones
 * to thumbnail scale so the transcript keeps rendering while the disk stops
 * growing, and everything it must NOT touch is asserted here alongside what it
 * does: an untagged attachment, a frame inside the window, and a file more than
 * one row names.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";

import { setDbMigrating, setDbReady } from "../daemon/daemon-readiness.js";
import { sweepAgedSightFrames } from "../daemon/sight-frame-storage-sweep.js";
import {
  attachInlineAttachmentToMessage,
  getAttachmentById,
  getAttachmentContent,
  getAttachmentMetadataForMessage,
  uploadFileBackedAttachment,
} from "../persistence/attachments-store.js";
import {
  addMessage,
  createConversation,
} from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { rawRun } from "../persistence/raw-query.js";
import { isCompleteJpeg } from "../util/image-conversion.js";
import { setConfig } from "./helpers/set-config.js";

setConfig("memory", { enabled: false });

await initializeDb();

const DAY_MS = 24 * 60 * 60 * 1000;

/** Comfortably over the sweep's 128 KB threshold, and small enough to encode fast. */
const FRAME_WIDTH = 1200;
const FRAME_HEIGHT = 900;

/**
 * A camera-frame-sized JPEG of random noise. Noise is what makes it big: a flat
 * image would encode under the threshold and never become a candidate.
 */
async function makeFrameJpegBase64(): Promise<string> {
  const { default: sharp } = await import("sharp");
  const bytes = await sharp(randomBytes(FRAME_WIDTH * FRAME_HEIGHT * 3), {
    raw: { width: FRAME_WIDTH, height: FRAME_HEIGHT, channels: 3 },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
  return bytes.toString("base64");
}

function resetTables() {
  const db = getDb();
  db.run("DELETE FROM message_attachments");
  db.run("DELETE FROM attachments");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

function backdateAttachment(attachmentId: string, ageDays: number): void {
  rawRun(
    "test:backdateAttachment",
    "UPDATE attachments SET created_at = ? WHERE id = ?",
    Date.now() - ageDays * DAY_MS,
    attachmentId,
  );
}

/** Tag an already-persisted row as carrying the given camera frames. */
function tagMessageFrames(messageId: string, attachmentIds: string[]): void {
  rawRun(
    "test:tagMessageFrames",
    "UPDATE messages SET metadata = ? WHERE id = ?",
    JSON.stringify({
      voiceSessionTurn: true,
      sightFrameAttachmentIds: attachmentIds,
    }),
    messageId,
  );
}

interface PlantedFrame {
  conversationId: string;
  messageId: string;
  attachmentId: string;
  filePath: string;
  sizeBytes: number;
}

/**
 * Persist one image as an attachment on a fresh conversation, tagging the row
 * as a camera frame unless `tagged` says otherwise, and backdate the attachment
 * so the sweep sees it as `ageDays` old.
 */
async function plantFrame(options: {
  ageDays: number;
  tagged: boolean;
}): Promise<PlantedFrame> {
  const conversation = createConversation("Call");
  const message = await addMessage(conversation.id, "user", "(camera frame)", {
    skipIndexing: true,
  });
  const stored = await attachInlineAttachmentToMessage(
    message.id,
    0,
    "sight-frame.jpg",
    "image/jpeg",
    await makeFrameJpegBase64(),
  );
  if (options.tagged) {
    tagMessageFrames(message.id, [stored.id]);
  }
  backdateAttachment(stored.id, options.ageDays);
  return {
    conversationId: conversation.id,
    messageId: message.id,
    attachmentId: stored.id,
    filePath: stored.filePath,
    sizeBytes: stored.sizeBytes,
  };
}

function storedSizeBytes(attachmentId: string): number {
  const row = getAttachmentById(attachmentId);
  expect(row).not.toBeNull();
  return row!.sizeBytes;
}

describe("sweepAgedSightFrames", () => {
  beforeEach(() => {
    resetTables();
    setDbReady(true);
  });

  test("shrinks an aged camera frame while the transcript keeps resolving it", async () => {
    const frame = await plantFrame({ ageDays: 30, tagged: true });
    expect(frame.sizeBytes).toBeGreaterThan(128 * 1024);

    const result = await sweepAgedSightFrames();

    expect(result.shrunk).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.freedBytes).toBeGreaterThan(0);

    // The bytes on disk are a smaller, complete JPEG.
    const onDisk = readFileSync(frame.filePath);
    expect(onDisk.length).toBeLessThan(frame.sizeBytes);
    expect(isCompleteJpeg(onDisk)).toBe(true);

    // The row still describes what it actually stores. `/attachments/:id/content`
    // serves `sizeBytes` as Content-Length, so a stale size truncates the image
    // the transcript is trying to draw.
    expect(storedSizeBytes(frame.attachmentId)).toBe(onDisk.length);

    // The row, its link, and its content all survive: the sweep deletes nothing.
    const linked = getAttachmentMetadataForMessage(frame.messageId);
    expect(linked.map((a) => a.id)).toEqual([frame.attachmentId]);
    expect(getAttachmentContent(frame.attachmentId)?.length).toBe(
      onDisk.length,
    );
  });

  test("leaves an untagged attachment of the same age alone", async () => {
    const frame = await plantFrame({ ageDays: 30, tagged: false });

    const result = await sweepAgedSightFrames();

    expect(result.shrunk).toBe(0);
    expect(storedSizeBytes(frame.attachmentId)).toBe(frame.sizeBytes);
    expect(readFileSync(frame.filePath).length).toBe(frame.sizeBytes);
  });

  test("leaves a tagged frame inside the retention window alone", async () => {
    const frame = await plantFrame({ ageDays: 1, tagged: true });

    const result = await sweepAgedSightFrames();

    expect(result.shrunk).toBe(0);
    expect(storedSizeBytes(frame.attachmentId)).toBe(frame.sizeBytes);
    expect(readFileSync(frame.filePath).length).toBe(frame.sizeBytes);
  });

  test("refuses a file a second attachment row still names", async () => {
    const frame = await plantFrame({ ageDays: 30, tagged: true });

    // The shape a clone leaves behind when materialization could not repoint it:
    // two rows, one file. Rewriting it would rewrite the other row's image too.
    const alias = uploadFileBackedAttachment(
      "sight-frame.jpg",
      "image/jpeg",
      frame.filePath,
      frame.sizeBytes,
    );

    const result = await sweepAgedSightFrames();

    expect(result.shrunk).toBe(0);
    expect(result.skipped).toBe(1);
    expect(readFileSync(frame.filePath).length).toBe(frame.sizeBytes);
    expect(storedSizeBytes(frame.attachmentId)).toBe(frame.sizeBytes);
    expect(storedSizeBytes(alias.id)).toBe(frame.sizeBytes);
  });

  test("refuses a file outside the attachment store's own directories", async () => {
    const conversation = createConversation("Call");
    const message = await addMessage(
      conversation.id,
      "user",
      "(camera frame)",
      { skipIndexing: true },
    );
    const outsideDir = join(tmpdir(), `vellum-sight-sweep-${Date.now()}`);
    mkdirSync(outsideDir, { recursive: true });
    const outsidePath = join(outsideDir, "user-owned.jpg");
    const bytes = Buffer.from(await makeFrameJpegBase64(), "base64");
    writeFileSync(outsidePath, bytes);

    const stored = uploadFileBackedAttachment(
      "user-owned.jpg",
      "image/jpeg",
      outsidePath,
      bytes.length,
    );
    rawRun(
      "test:linkOutsideAttachment",
      "INSERT INTO message_attachments (id, message_id, attachment_id, position, created_at) VALUES (?, ?, ?, 0, ?)",
      `link-${stored.id}`,
      message.id,
      stored.id,
      Date.now(),
    );
    tagMessageFrames(message.id, [stored.id]);
    backdateAttachment(stored.id, 30);

    const result = await sweepAgedSightFrames();

    expect(result.shrunk).toBe(0);
    expect(result.skipped).toBe(1);
    expect(existsSync(outsidePath)).toBe(true);
    expect(readFileSync(outsidePath).length).toBe(bytes.length);
  });

  test("skips every cycle while DB migrations are unready", async () => {
    const frame = await plantFrame({ ageDays: 30, tagged: true });
    setDbMigrating();

    const result = await sweepAgedSightFrames();

    expect(result).toEqual({ shrunk: 0, freedBytes: 0, skipped: 0 });
    expect(storedSizeBytes(frame.attachmentId)).toBe(frame.sizeBytes);
  });

  test("re-running finds nothing once a frame has been swept", async () => {
    const frame = await plantFrame({ ageDays: 30, tagged: true });

    const first = await sweepAgedSightFrames();
    expect(first.shrunk).toBe(1);
    const sweptSize = storedSizeBytes(frame.attachmentId);
    const sweptBytes = readFileSync(frame.filePath);

    const second = await sweepAgedSightFrames();

    // Nothing is even a candidate the second time: the swept size is what the
    // query bounds on, so an already-shrunk frame is not re-read or re-encoded.
    expect(second).toEqual({ shrunk: 0, freedBytes: 0, skipped: 0 });
    expect(storedSizeBytes(frame.attachmentId)).toBe(sweptSize);
    expect(readFileSync(frame.filePath).equals(sweptBytes)).toBe(true);
  });
});
