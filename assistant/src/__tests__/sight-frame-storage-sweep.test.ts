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
 *
 * Two properties are about the pass rather than the frame, and both are failures
 * of the shape where nothing looks broken. A pass has to walk PAST the frames it
 * cannot rewrite, or a wall of them at the oldest end starves every frame behind
 * it and storage grows again. And a row update that throws after the new bytes
 * landed has to put the original back, or the row overstates a size the content
 * route serves as `Content-Length`.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";

import { setDbMigrating, setDbReady } from "../daemon/daemon-readiness.js";
import {
  getSightFrameSweepCursorForTest,
  resetSightFrameSweepCursorForTest,
  sweepAgedSightFrames,
} from "../daemon/sight-frame-storage-sweep.js";
import {
  attachInlineAttachmentToMessage,
  getAttachmentById,
  getAttachmentContent,
  getAttachmentMetadataForMessage,
  getFilePathForAttachment,
  uploadAttachment,
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
import { getConversationsDir } from "../util/platform.js";
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
  db.run("DROP TRIGGER IF EXISTS test_block_shrink");
  db.run("DELETE FROM message_attachments");
  db.run("DELETE FROM attachments");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

/**
 * Make the row update inside `shrinkAttachmentBytes` throw for one attachment,
 * at the real seam rather than through a module mock, so the recovery path runs
 * against the same statement production uses. The id is interpolated because
 * `CREATE TRIGGER` takes no bind parameters; it is a uuid this file just minted.
 */
function failNextRowUpdate(attachmentId: string): void {
  getDb().run(
    `CREATE TRIGGER test_block_shrink BEFORE UPDATE ON attachments
     FOR EACH ROW WHEN NEW.id = '${attachmentId}'
     BEGIN SELECT RAISE(ABORT, 'forced row update failure'); END`,
  );
}

function clearRowUpdateFailure(): void {
  getDb().run("DROP TRIGGER IF EXISTS test_block_shrink");
}

function backdateAttachment(attachmentId: string, ageDays: number): void {
  rawRun(
    "test:backdateAttachment",
    "UPDATE attachments SET created_at = ? WHERE id = ?",
    Date.now() - ageDays * DAY_MS,
    attachmentId,
  );
}

/**
 * Link an attachment to a message without scoping it into the conversation.
 * `linkAttachmentToMessage` materializes as it links, which is exactly what the
 * degraded shapes below need to skip.
 */
function linkAttachmentWithoutScoping(
  messageId: string,
  attachmentId: string,
): void {
  rawRun(
    "test:linkAttachmentWithoutScoping",
    "INSERT INTO message_attachments (id, message_id, attachment_id, position, created_at) VALUES (?, ?, ?, 0, ?)",
    `link-${attachmentId}`,
    messageId,
    attachmentId,
    Date.now(),
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
 * A wall of aged frames the sweep can never rewrite, all naming one file so each
 * is refused as shared. Written by hand rather than through the store because no
 * bytes are ever read: the point is a candidate set larger than one page that
 * yields nothing, which is the shape that starves everything behind it.
 *
 * They share one tagged message, the way a spoken turn carrying several parked
 * frames does.
 */
async function plantRefusedFrames(
  count: number,
  ageDays: number,
): Promise<void> {
  const conversation = createConversation("Call");
  const message = await addMessage(conversation.id, "user", "(camera frame)", {
    skipIndexing: true,
  });
  // Inside the store's own tree, so the rows are refused as SHARED rather than
  // as foreign. The file itself never has to exist: nothing reads it.
  const sharedPath = join(
    getConversationsDir(),
    "2026-01-01T00-00-00.000Z_shared",
    "attachments",
    "shared-frame.jpg",
  );
  const createdAt = Date.now() - ageDays * DAY_MS;
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `refused-${String(i).padStart(4, "0")}`;
    ids.push(id);
    rawRun(
      "test:plantRefusedFrame",
      `INSERT INTO attachments (id, original_filename, mime_type, size_bytes, kind, data_base64, file_path, created_at)
       VALUES (?, 'shared-frame.jpg', 'image/jpeg', ?, 'image', '', ?, ?)`,
      id,
      2 * 1024 * 1024,
      sharedPath,
      createdAt + i,
    );
    linkAttachmentWithoutScoping(message.id, id);
  }
  tagMessageFrames(message.id, ids);
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
    resetSightFrameSweepCursorForTest();
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
    linkAttachmentWithoutScoping(message.id, stored.id);
    tagMessageFrames(message.id, [stored.id]);
    backdateAttachment(stored.id, 30);

    const result = await sweepAgedSightFrames();

    expect(result.shrunk).toBe(0);
    expect(result.skipped).toBe(1);
    expect(existsSync(outsidePath)).toBe(true);
    expect(readFileSync(outsidePath).length).toBe(bytes.length);
  });

  test("re-encodes a frame whose bytes are still inline in the row", async () => {
    // The shape materialization leaves when it finds nothing readable to copy:
    // a linked row still holding its payload in the database, which is the last
    // place a frame nobody chose to send should grow.
    const conversation = createConversation("Call");
    const message = await addMessage(
      conversation.id,
      "user",
      "(camera frame)",
      {
        skipIndexing: true,
      },
    );
    const stored = await uploadAttachment(
      "sight-frame.jpg",
      "image/jpeg",
      await makeFrameJpegBase64(),
    );
    linkAttachmentWithoutScoping(message.id, stored.id);
    tagMessageFrames(message.id, [stored.id]);
    backdateAttachment(stored.id, 30);
    expect(getFilePathForAttachment(stored.id)).toBeNull();

    const result = await sweepAgedSightFrames();

    expect(result.shrunk).toBe(1);
    const swept = getAttachmentById(stored.id);
    expect(swept!.dataBase64.length).toBeGreaterThan(0);
    expect(Buffer.from(swept!.dataBase64, "base64").length).toBe(
      swept!.sizeBytes,
    );
    expect(swept!.sizeBytes).toBeLessThan(stored.sizeBytes);
    // Still inline: the sweep re-encodes what is there rather than changing how
    // the row stores it.
    expect(getFilePathForAttachment(stored.id)).toBeNull();
  });

  test("skips every cycle while DB migrations are unready", async () => {
    const frame = await plantFrame({ ageDays: 30, tagged: true });
    setDbMigrating();

    const result = await sweepAgedSightFrames();

    expect(result).toEqual({
      shrunk: 0,
      freedBytes: 0,
      skipped: 0,
      examined: 0,
    });
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
    expect(second).toEqual({
      shrunk: 0,
      freedBytes: 0,
      skipped: 0,
      examined: 0,
    });
    expect(storedSizeBytes(frame.attachmentId)).toBe(sweptSize);
    expect(readFileSync(frame.filePath).equals(sweptBytes)).toBe(true);
  });

  test("reaches a younger frame behind more refusals than one page holds", async () => {
    // Older than the frame below, so an ascending scan meets them first, and
    // more of them than a page, so a pass that could not step past them would
    // hand back the same wall every time and never see what is behind it.
    await plantRefusedFrames(250, 30);
    const frame = await plantFrame({ ageDays: 8, tagged: true });

    const result = await sweepAgedSightFrames();

    expect(result.shrunk).toBe(1);
    expect(result.skipped).toBe(250);
    expect(result.examined).toBe(251);
    expect(storedSizeBytes(frame.attachmentId)).toBeLessThan(frame.sizeBytes);
  });

  test("a pass that stops on its bound resumes where it left off", async () => {
    const oldest = await plantFrame({ ageDays: 30, tagged: true });
    const middle = await plantFrame({ ageDays: 20, tagged: true });
    const newest = await plantFrame({ ageDays: 10, tagged: true });

    const first = await sweepAgedSightFrames({ maxEncodeAttempts: 1 });
    expect(first.shrunk).toBe(1);
    expect(getSightFrameSweepCursorForTest()?.id).toBe(oldest.attachmentId);
    expect(storedSizeBytes(oldest.attachmentId)).toBeLessThan(oldest.sizeBytes);
    expect(storedSizeBytes(middle.attachmentId)).toBe(middle.sizeBytes);

    const second = await sweepAgedSightFrames({ maxEncodeAttempts: 1 });
    expect(second.shrunk).toBe(1);
    expect(getSightFrameSweepCursorForTest()?.id).toBe(middle.attachmentId);
    expect(storedSizeBytes(middle.attachmentId)).toBeLessThan(middle.sizeBytes);
    expect(storedSizeBytes(newest.attachmentId)).toBe(newest.sizeBytes);

    // The pass that runs out of rows wraps, so newly aged frames are seen again.
    await sweepAgedSightFrames({ maxEncodeAttempts: 1 });
    await sweepAgedSightFrames({ maxEncodeAttempts: 1 });
    expect(getSightFrameSweepCursorForTest()).toBeNull();
    expect(storedSizeBytes(newest.attachmentId)).toBeLessThan(newest.sizeBytes);
  });

  test("puts the original bytes back when recording the new size throws", async () => {
    const frame = await plantFrame({ ageDays: 30, tagged: true });
    const original = readFileSync(frame.filePath);

    failNextRowUpdate(frame.attachmentId);
    try {
      const failed = await sweepAgedSightFrames();
      expect(failed.shrunk).toBe(0);
      expect(failed.skipped).toBe(1);
    } finally {
      clearRowUpdateFailure();
    }

    // The row and the file still agree, which is the whole point: a thumbnail
    // left under a row claiming the original size is served with a
    // Content-Length no reader can satisfy.
    expect(readFileSync(frame.filePath).equals(original)).toBe(true);
    expect(storedSizeBytes(frame.attachmentId)).toBe(frame.sizeBytes);
    expect(existsSync(`${frame.filePath}.sweep-bak`)).toBe(false);
    expect(existsSync(`${frame.filePath}.sweep-tmp`)).toBe(false);

    // Still a candidate, so the next pass finishes what this one could not.
    const recovered = await sweepAgedSightFrames();
    expect(recovered.shrunk).toBe(1);
    expect(readFileSync(frame.filePath).length).toBeLessThan(original.length);
    expect(storedSizeBytes(frame.attachmentId)).toBe(
      readFileSync(frame.filePath).length,
    );
  });

  test("converges on a row a killed process left overstating its size", async () => {
    // What a crash between the file rename and the row update leaves: the
    // thumbnail is on disk, the row still claims the original size. That is the
    // reason the file is written FIRST. An overstated size keeps the row above
    // the sweep's threshold, so it is still a candidate and the next pass
    // finishes the job; a DB-first order would understate it instead, drop the
    // row below the threshold, and strand the full-size file forever.
    const frame = await plantFrame({ ageDays: 30, tagged: true });
    await sweepAgedSightFrames();
    const onDisk = readFileSync(frame.filePath).length;
    expect(onDisk).toBeLessThan(frame.sizeBytes);

    rawRun(
      "test:restoreStaleSize",
      "UPDATE attachments SET size_bytes = ? WHERE id = ?",
      frame.sizeBytes,
      frame.attachmentId,
    );

    const result = await sweepAgedSightFrames();

    expect(result.shrunk).toBe(1);
    expect(storedSizeBytes(frame.attachmentId)).toBe(
      readFileSync(frame.filePath).length,
    );
    expect(storedSizeBytes(frame.attachmentId)).toBeLessThan(frame.sizeBytes);
  });
});
