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
 * The rest are about the pass rather than the frame, and all of them are
 * failures of the shape where nothing looks broken. A pass has to walk PAST the
 * frames it cannot rewrite, or a wall of them at the oldest end starves every
 * frame behind it and storage grows again. A row update that throws after the
 * new bytes landed has to put the original back, or the row overstates a size
 * the content route serves as `Content-Length`. And the files a killed process
 * leaves mid-shrink have to be judged by the rows that point at them rather than
 * by their names, which are derived from an attachment's own path and can
 * therefore belong to a real attachment.
 */

import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";

import { setDbMigrating, setDbReady } from "../daemon/daemon-readiness.js";
import {
  CATCH_UP_SWEEP_DELAY_MS,
  getSightFrameSweepBackupCursorForTest,
  getSightFrameSweepCursorForTest,
  getSightFrameSweepDirEnumerationsForTest,
  resetSightFrameSweepCursorForTest,
  SWEEP_INTERVAL_MS,
  sweepAgedSightFrames,
  sweepDelayAfter,
} from "../daemon/sight-frame-storage-sweep.js";
import {
  attachInlineAttachmentToMessage,
  getAttachmentById,
  getAttachmentContent,
  getAttachmentMetadataForMessage,
  getFilePathForAttachment,
  SIGHT_FRAME_SWEEP_CONTINUATION_SQL,
  SIGHT_FRAME_SWEEP_FIRST_PAGE_SQL,
  SIGHT_FRAME_TAG_PROBE_LIMIT,
  SWEEP_BACKUP_SUFFIX,
  SWEEP_TEMP_SUFFIX,
  uploadAttachment,
  uploadFileBackedAttachment,
} from "../persistence/attachments-store.js";
import {
  addMessage,
  createConversation,
} from "../persistence/conversation-crud.js";
import { getDb, getSqlite } from "../persistence/db-connection.js";
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

/**
 * A real file with a row naming it as its canonical bytes, for names that
 * collide with the sweep's own sidecar suffixes.
 */
function plantCanonicalFile(
  dir: string,
  filename: string,
): { id: string; path: string; bytes: Buffer } {
  const path = join(dir, filename);
  const bytes = Buffer.alloc(2048, 5);
  writeFileSync(path, bytes);
  const id = `canonical-${filename}`;
  rawRun(
    "test:plantCanonicalFile",
    `INSERT INTO attachments (id, original_filename, mime_type, size_bytes, kind, data_base64, file_path, created_at)
     VALUES (?, ?, 'image/jpeg', ?, 'image', '', ?, ?)`,
    id,
    filename,
    bytes.length,
    path,
    Date.now(),
  );
  return { id, path, bytes };
}

/**
 * Aged, large, image attachments that carry no sight tag at all: the shape of an
 * ordinary photo library sitting in the index range the sweep pages through.
 * They are what the page has to walk past, and what a `LIMIT` that bounded
 * matches rather than visits would let it walk past for free.
 */
async function plantUntaggedImages(count: number): Promise<void> {
  const conversation = createConversation("Album");
  const message = await addMessage(conversation.id, "user", "photos", {
    skipIndexing: true,
  });
  const filePath = join(
    getConversationsDir(),
    "2026-01-01T00-00-00.000Z_album",
    "attachments",
    "photo.jpg",
  );
  const createdAt = Date.now() - 30 * DAY_MS;
  for (let i = 0; i < count; i++) {
    rawRun(
      "test:plantUntaggedImage",
      `INSERT INTO attachments (id, original_filename, mime_type, size_bytes, kind, data_base64, file_path, created_at)
       VALUES (?, 'photo.jpg', 'image/jpeg', ?, 'image', '', ?, ?)`,
      `untagged-${String(i).padStart(4, "0")}`,
      2 * 1024 * 1024,
      filePath,
      createdAt + i,
    );
    linkAttachmentWithoutScoping(
      message.id,
      `untagged-${String(i).padStart(4, "0")}`,
    );
  }
}

/** Every step SQLite reports for a query, joined so a test can assert over the whole plan. */
function queryPlanFor(sql: string, binds: Array<string | number>): string {
  const plan = getSqlite()
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...binds) as Array<{ detail: string }>;
  return plan.map((step) => step.detail).join("\n");
}

/** A pass that found nothing to do and nothing to reclaim. */
const NOTHING_HAPPENED = {
  shrunk: 0,
  freedBytes: 0,
  skipped: 0,
  examined: 0,
  rowsRead: 0,
  leftovers: { deleted: 0, restored: 0, skipped: 0 },
  stoppedOnBudget: false,
};

/**
 * Attachments the prefilter admits and the tag check rejects: each is linked to
 * a message that mentions the sight key while naming some other attachment.
 * They cost a page slot and a metadata lookup apiece and produce no candidate,
 * which is the population the row budget exists for.
 */
async function plantPrefilterNearMisses(count: number): Promise<void> {
  const conversation = createConversation("Call");
  const message = await addMessage(conversation.id, "user", "(camera frame)", {
    skipIndexing: true,
  });
  const filePath = join(
    getConversationsDir(),
    "2026-01-01T00-00-00.000Z_near-miss",
    "attachments",
    "near-miss.jpg",
  );
  const createdAt = Date.now() - 30 * DAY_MS;
  for (let i = 0; i < count; i++) {
    const id = `near-miss-${String(i).padStart(4, "0")}`;
    rawRun(
      "test:plantNearMiss",
      `INSERT INTO attachments (id, original_filename, mime_type, size_bytes, kind, data_base64, file_path, created_at)
       VALUES (?, 'near-miss.jpg', 'image/jpeg', ?, 'image', '', ?, ?)`,
      id,
      2 * 1024 * 1024,
      filePath,
      createdAt + i,
    );
    linkAttachmentWithoutScoping(message.id, id);
  }
  tagMessageFrames(message.id, ["names-nobody-here"]);
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

    expect(result).toEqual(NOTHING_HAPPENED);
    expect(storedSizeBytes(frame.attachmentId)).toBe(frame.sizeBytes);
  });

  test("re-running finds nothing once a frame has been swept", async () => {
    const frame = await plantFrame({ ageDays: 30, tagged: true });

    const first = await sweepAgedSightFrames();
    expect(first.shrunk).toBe(1);
    const sweptSize = storedSizeBytes(frame.attachmentId);
    const sweptBytes = readFileSync(frame.filePath);

    const second = await sweepAgedSightFrames();

    // The row is still walked, because the page is a plain index range over age
    // and the size threshold is applied to what it returns. What matters is that
    // it stops being a CANDIDATE, so nothing re-reads or re-encodes its bytes.
    expect(second.shrunk).toBe(0);
    expect(second.examined).toBe(0);
    expect(second.skipped).toBe(0);
    expect(second.freedBytes).toBe(0);
    expect(second.rowsRead).toBe(1);
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

  test("sweeps a frame only its second linked message tags", async () => {
    // An attachment can hang off several messages, and only one of them need
    // name it. A page that ended on one of the others used to advance the cursor
    // past the attachment on that row's say-so, and the next page's strict `>`
    // then excluded the link that would have qualified it, permanently. The page
    // is one row per ATTACHMENT now, so no page boundary can fall between an
    // attachment's own links.
    const conversation = createConversation("Call");
    const untagging = await addMessage(
      conversation.id,
      "user",
      "(camera frame)",
      { skipIndexing: true },
    );
    const stored = await attachInlineAttachmentToMessage(
      untagging.id,
      0,
      "sight-frame.jpg",
      "image/jpeg",
      await makeFrameJpegBase64(),
    );
    // Mentions the key, names somebody else. Linked first, so a page of one
    // taken from the old join would land on this row.
    tagMessageFrames(untagging.id, ["names-nobody-here"]);

    const tagging = await addMessage(
      conversation.id,
      "user",
      "(camera frame)",
      {
        skipIndexing: true,
      },
    );
    linkAttachmentWithoutScoping(tagging.id, stored.id);
    tagMessageFrames(tagging.id, [stored.id]);
    backdateAttachment(stored.id, 30);

    const result = await sweepAgedSightFrames({ pageSize: 1 });

    expect(result.shrunk).toBe(1);
    expect(storedSizeBytes(stored.id)).toBeLessThan(stored.sizeBytes);
  });

  test("spends its row budget on prefilter near-misses and stops", async () => {
    await plantPrefilterNearMisses(60);

    const result = await sweepAgedSightFrames({
      pageSize: 10,
      maxRowsRead: 20,
    });

    // Not one of them is a candidate, so a budget counted in candidates would
    // never bind and the pass would page the whole backlog every hour.
    expect(result.examined).toBe(0);
    expect(result.rowsRead).toBeGreaterThanOrEqual(20);
    expect(result.rowsRead).toBeLessThan(60);
    // Stopped part way, with somewhere to resume from rather than a wrap.
    expect(getSightFrameSweepCursorForTest()).not.toBeNull();
  });

  test("reclaims a backup whose row already describes the file in place", async () => {
    const frame = await plantFrame({ ageDays: 30, tagged: true });
    await sweepAgedSightFrames();
    const thumbnail = readFileSync(frame.filePath);

    // What a process killed between the row update and the unlink leaves. The
    // row reports the thumbnail now, so it never selects again and this pass is
    // the last one that would ever have looked at it.
    const orphaned = `${frame.filePath}${SWEEP_BACKUP_SUFFIX}`;
    writeFileSync(orphaned, Buffer.alloc(frame.sizeBytes, 7));

    // And one whose row is gone entirely, which no row-driven probe would find.
    const strandedBase = join(
      getConversationsDir(),
      "2026-01-01T00-00-00.000Z_stranded",
      "attachments",
      "stranded.jpg",
    );
    mkdirSync(dirname(strandedBase), { recursive: true });
    writeFileSync(strandedBase, Buffer.alloc(1024, 3));
    const stranded = `${strandedBase}${SWEEP_BACKUP_SUFFIX}`;
    writeFileSync(stranded, Buffer.alloc(4096, 9));

    const result = await sweepAgedSightFrames({ maxBackupDirs: 1000 });

    expect(result.leftovers.deleted).toBe(2);
    expect(existsSync(orphaned)).toBe(false);
    expect(existsSync(stranded)).toBe(false);
    // The frame itself is untouched by the reclaim.
    expect(readFileSync(frame.filePath).equals(thumbnail)).toBe(true);
  });

  test("keeps a backup whose row still overstates what is on disk", async () => {
    const frame = await plantFrame({ ageDays: 30, tagged: true });
    await sweepAgedSightFrames();
    const original = Buffer.alloc(frame.sizeBytes, 7);

    // The other crash window: the rename landed, the row update did not. The
    // backup is the only full copy left, and the row still selects, so the next
    // shrink attempt is what reclaims it.
    const backup = `${frame.filePath}${SWEEP_BACKUP_SUFFIX}`;
    writeFileSync(backup, original);
    rawRun(
      "test:restoreStaleSize",
      "UPDATE attachments SET size_bytes = ? WHERE id = ?",
      frame.sizeBytes,
      frame.attachmentId,
    );

    // Encode nothing, so the reclaim is the only thing this pass does.
    const reclaimOnly = await sweepAgedSightFrames({
      maxEncodeAttempts: 0,
      maxBackupDirs: 1000,
    });

    expect(reclaimOnly.leftovers.deleted).toBe(0);
    expect(reclaimOnly.leftovers.skipped).toBeGreaterThanOrEqual(1);
    expect(existsSync(backup)).toBe(true);
    expect(readFileSync(backup).equals(original)).toBe(true);

    // Convergence still happens, and takes the backup with it.
    const converged = await sweepAgedSightFrames({ maxBackupDirs: 1000 });
    expect(converged.shrunk).toBe(1);
    expect(storedSizeBytes(frame.attachmentId)).toBe(
      readFileSync(frame.filePath).length,
    );
    expect(existsSync(backup)).toBe(false);
  });

  test("leaves alone a stored file whose own name ends in a sweep suffix", async () => {
    // The suffixes are derived from an attachment's path, not reserved. A user
    // can pick a file called `holiday.jpg.sweep-tmp`, the store keeps the name,
    // and it lands in a directory the reclaim scans. Deleting it on the strength
    // of its name destroys canonical bytes a row and a transcript still point at.
    const frame = await plantFrame({ ageDays: 30, tagged: true });
    const dir = dirname(frame.filePath);
    const namedLikeTemp = plantCanonicalFile(
      dir,
      `holiday.jpg${SWEEP_TEMP_SUFFIX}`,
    );
    const namedLikeBackup = plantCanonicalFile(
      dir,
      `holiday.jpg${SWEEP_BACKUP_SUFFIX}`,
    );

    const result = await sweepAgedSightFrames({ maxBackupDirs: 1000 });

    expect(result.leftovers.deleted).toBe(0);
    expect(result.leftovers.skipped).toBe(2);
    expect(readFileSync(namedLikeTemp.path).equals(namedLikeTemp.bytes)).toBe(
      true,
    );
    expect(
      readFileSync(namedLikeBackup.path).equals(namedLikeBackup.bytes),
    ).toBe(true);
    expect(getAttachmentContent(namedLikeTemp.id)?.length).toBe(
      namedLikeTemp.bytes.length,
    );
  });

  test("refuses to shrink a frame whose sidecar names are already taken", async () => {
    const frame = await plantFrame({ ageDays: 30, tagged: true });
    const original = readFileSync(frame.filePath);
    // Another row's canonical bytes sitting exactly where this frame's backup
    // would go. Writing there would take that attachment's only copy.
    const squatter = plantCanonicalFile(
      dirname(frame.filePath),
      `${basename(frame.filePath)}${SWEEP_BACKUP_SUFFIX}`,
    );

    const result = await sweepAgedSightFrames({ maxBackupDirs: 1000 });

    expect(result.shrunk).toBe(0);
    expect(result.skipped).toBe(1);
    expect(readFileSync(frame.filePath).equals(original)).toBe(true);
    expect(readFileSync(squatter.path).equals(squatter.bytes)).toBe(true);
  });

  test("restores a base file a crash left missing between the two renames", async () => {
    const frame = await plantFrame({ ageDays: 30, tagged: true });
    const original = readFileSync(frame.filePath);

    // The window between the renames: the original is aside under the backup
    // name, the replacement is written but not promoted, and the row points at
    // nothing at all.
    const backup = `${frame.filePath}${SWEEP_BACKUP_SUFFIX}`;
    const temp = `${frame.filePath}${SWEEP_TEMP_SUFFIX}`;
    renameSync(frame.filePath, backup);
    writeFileSync(temp, Buffer.alloc(4096, 1));
    expect(getAttachmentContent(frame.attachmentId)).toBeNull();

    const reclaimOnly = await sweepAgedSightFrames({
      maxEncodeAttempts: 0,
      maxBackupDirs: 1000,
    });

    // Keeping the backup where it lay would have left the frame unreadable for
    // as long as the row survived, since nothing else ever puts it back.
    expect(reclaimOnly.leftovers.restored).toBe(1);
    expect(readFileSync(frame.filePath).equals(original)).toBe(true);
    expect(existsSync(backup)).toBe(false);
    // The temp beside it is debris once the base it would have replaced is back.
    expect(existsSync(temp)).toBe(false);
    expect(getAttachmentContent(frame.attachmentId)?.length).toBe(
      original.length,
    );

    // Readable again and still over the threshold, so the sweep finishes it.
    const converged = await sweepAgedSightFrames({ maxBackupDirs: 1000 });
    expect(converged.shrunk).toBe(1);
    expect(storedSizeBytes(frame.attachmentId)).toBe(
      readFileSync(frame.filePath).length,
    );
  });

  test("opens on an index range rather than a scan and a sort", () => {
    // Without `idx_attachments_created_at_id` every page would re-scan the whole
    // attachments table and re-sort it, and the row budget bounds rows RETURNED,
    // not rows visited, so a large install's hourly pass would pay for that once
    // per page.
    const detail = queryPlanFor(SIGHT_FRAME_SWEEP_FIRST_PAGE_SQL, [
      Date.now(),
      200,
    ]);

    expect(detail).toContain("USING INDEX idx_attachments_created_at_id");
    expect(detail).toContain("created_at<?");
    expect(detail).not.toContain("USE TEMP B-TREE");
    // `SCAN a` is the whole-table read the index replaces. The subquery's own
    // steps are SEARCHes on indexes that already existed.
    expect(detail).not.toMatch(/\bSCAN a\b/);
  });

  test("visits no more rows than its budget through an untagged backlog", async () => {
    // The population that used to be invisible. Every one of these is aged,
    // large, and an image, so the only thing that disqualifies it is the sight
    // tag. With the tag test in SQL, one page would walk all 60 index entries
    // probing message_attachments for each and return nothing, none of it
    // charged. The page is a plain index range now, so a visit is a returned
    // row and the budget is a real bound.
    await plantUntaggedImages(60);

    const result = await sweepAgedSightFrames({
      pageSize: 10,
      maxRowsRead: 20,
    });

    expect(result.shrunk).toBe(0);
    expect(result.examined).toBe(0);
    // One page of ten rows plus the ten links its tag checks read, which spends
    // the budget exactly. Every visit is counted, the probe's included.
    expect(result.rowsRead).toBe(20);
    // Stopped part way with somewhere to resume from, not a wrap.
    expect(getSightFrameSweepCursorForTest()).not.toBeNull();
  });

  test("charges every visited row when the range holds no candidates", async () => {
    await plantUntaggedImages(12);

    const result = await sweepAgedSightFrames({ pageSize: 100 });

    // One page covering all twelve, plus the one linked message each of them
    // costs the tag check. Every visit is charged, the probe's included.
    expect(result.rowsRead).toBe(24);
    expect(result.examined).toBe(0);
    expect(getSightFrameSweepCursorForTest()).toBeNull();
  });

  test("caps the links one candidate's tag check reads", async () => {
    // A frame hangs off one message by construction, so the cap costs a real
    // one nothing. What it stops is an attachment with an unusual link count
    // turning a single candidate into an unbounded read, invisible to the
    // budget because only the survivors used to be counted.
    const frame = await plantFrame({ ageDays: 30, tagged: true });
    const extraLinks = SIGHT_FRAME_TAG_PROBE_LIMIT * 3;
    for (let i = 0; i < extraLinks; i++) {
      const extra = await addMessage(frame.conversationId, "user", "turn", {
        skipIndexing: true,
      });
      rawRun(
        "test:extraSightLink",
        "INSERT INTO message_attachments (id, message_id, attachment_id, position, created_at) VALUES (?, ?, ?, 0, ?)",
        `extra-link-${i}`,
        extra.id,
        frame.attachmentId,
        Date.now(),
      );
      tagMessageFrames(extra.id, [frame.attachmentId]);
    }

    const result = await sweepAgedSightFrames();

    // Still verified, and still swept.
    expect(result.shrunk).toBe(1);
    // One page row plus the capped probe, not one row per link.
    expect(result.rowsRead).toBe(1 + SIGHT_FRAME_TAG_PROBE_LIMIT);
  });

  test("comes back on the catch-up cadence only while work is left", async () => {
    // The gate will not keep two frames inside five seconds, so a call with the
    // camera up all hour persists at most 720. A pass attempts 200, so at the
    // resting cadence the backlog would grow faster than it drains; the
    // catch-up cadence turns that into 2400 an hour against a ceiling of 720.
    const frames = [
      await plantFrame({ ageDays: 30, tagged: true }),
      await plantFrame({ ageDays: 20, tagged: true }),
    ];
    expect(frames).toHaveLength(2);

    const spent = await sweepAgedSightFrames({ maxEncodeAttempts: 1 });
    expect(spent.stoppedOnBudget).toBe(true);
    expect(sweepDelayAfter(spent)).toBe(CATCH_UP_SWEEP_DELAY_MS);

    // Draining the rest leaves nothing behind, so the sweep goes back to
    // resting rather than spinning at the short delay forever.
    const drained = await sweepAgedSightFrames();
    expect(drained.stoppedOnBudget).toBe(false);
    expect(sweepDelayAfter(drained)).toBe(SWEEP_INTERVAL_MS);
  });

  test("seeks a continuation page straight to the cursor", () => {
    // The lower bound is the half that makes paging linear. A cursor predicate
    // SQLite cannot fold into the index range still SEARCHes, but from the
    // oldest eligible entry every time, so walking a backlog costs index visits
    // quadratic in the pages walked. The tuple has to reach the constraint.
    const detail = queryPlanFor(SIGHT_FRAME_SWEEP_CONTINUATION_SQL, [
      Date.now(),
      Date.now() - DAY_MS,
      "att-cursor",
      200,
    ]);

    expect(detail).toContain("USING INDEX idx_attachments_created_at_id");
    expect(detail).toContain("(created_at,id)>(?,?)");
    expect(detail).not.toContain("USE TEMP B-TREE");
    expect(detail).not.toMatch(/\bSCAN a\b/);
  });

  test("lists the conversations directory once per cycle, not once per pass", async () => {
    // Discovery is O(all conversations). Doing it every pass would leave the
    // advertised bound covering the child scans while the listing that feeds
    // them grew with the workspace.
    for (const suffix of ["aaa", "bbb", "ccc"]) {
      mkdirSync(
        join(
          getConversationsDir(),
          `2026-02-01T00-00-00.000Z_${suffix}`,
          "attachments",
        ),
        { recursive: true },
      );
    }

    await sweepAgedSightFrames({ maxBackupDirs: 1 });
    expect(getSightFrameSweepDirEnumerationsForTest()).toBe(1);
    expect(getSightFrameSweepBackupCursorForTest()).not.toBeNull();

    await sweepAgedSightFrames({ maxBackupDirs: 1 });
    await sweepAgedSightFrames({ maxBackupDirs: 1 });
    expect(getSightFrameSweepDirEnumerationsForTest()).toBe(1);

    // Finishing the cycle is what earns a fresh listing, which is also how a
    // conversation created since the cycle began gets picked up.
    await sweepAgedSightFrames({ maxBackupDirs: 10_000 });
    expect(getSightFrameSweepBackupCursorForTest()).toBeNull();
    expect(getSightFrameSweepDirEnumerationsForTest()).toBe(1);

    await sweepAgedSightFrames({ maxBackupDirs: 1 });
    expect(getSightFrameSweepDirEnumerationsForTest()).toBe(2);
  });

  test("deletes a backup whose base is missing and whose row is gone", async () => {
    const frame = await plantFrame({ ageDays: 30, tagged: true });
    const backup = `${frame.filePath}${SWEEP_BACKUP_SUFFIX}`;
    renameSync(frame.filePath, backup);
    rawRun(
      "test:dropAttachmentRow",
      "DELETE FROM attachments WHERE id = ?",
      frame.attachmentId,
    );

    const result = await sweepAgedSightFrames({ maxBackupDirs: 1000 });

    expect(result.leftovers.restored).toBe(0);
    expect(result.leftovers.deleted).toBe(1);
    expect(existsSync(backup)).toBe(false);
  });
});
