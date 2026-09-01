/**
 * Long-term storage retention for ambient camera frames.
 *
 * The counterpart to `conversation-sight-frames.ts`, which bounds what a frame
 * costs the model. That pass rewrites the copy of the history a turn is about
 * to send and never touches what is stored. This one bounds what a frame costs
 * the disk: a call samples a frame every few seconds for as long as the camera
 * is up, and each one is a full-resolution image that outlives the call.
 *
 * Aged frames are re-encoded to a thumbnail in place, so the transcript block
 * keeps resolving and the row, its links, and its message content are left
 * exactly as they were. Deleting a conversation is still the only thing that
 * removes a frame; this sweep never deletes a row.
 *
 * The bytes are the only thing that changes. In particular the persist-time
 * `sizeBytes` / `width` / `height` hints on the message's own `workspace_ref`
 * block are left alone: they are message content, which the retention pass
 * above reads, and after a sweep they merely overstate the block, which costs
 * the token estimator nothing but conservatism. The provider path re-reads and
 * re-sniffs the stored bytes on every send (`providers/media-resolve.ts`), so
 * what the model receives is always what is actually on disk.
 */

import { getConfig } from "../config/loader.js";
import {
  MAX_SIGHT_SWEEP_AFTER_DAYS,
  MIN_SIGHT_SWEEP_AFTER_DAYS,
  SWEEP_SIGHT_FRAMES_AFTER_DAYS,
} from "../config/schemas/sight.js";
import {
  getAttachmentContent,
  selectSightFrameSweepCandidates,
  shrinkAttachmentBytes,
} from "../persistence/attachments-store.js";
import { convertImageToJpeg } from "../util/image-conversion.js";
import { getLogger } from "../util/logger.js";
import { getDbMigrationReadiness } from "./daemon-readiness.js";

const log = getLogger("sight-frame-storage-sweep");

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Longest side a swept frame keeps: enough to recognize the room, not to read it. */
const SWEPT_MAX_DIMENSION_PX = 512;

/** JPEG quality for a swept frame. Below transport quality; nothing re-reads these for detail. */
const SWEPT_JPEG_QUALITY = 60;

/**
 * Size at or under which a frame counts as already swept.
 *
 * This is the sweep's idempotence signal, and it is a stored column rather than
 * a new marker because the alternatives are worse: pixel dimensions would mean
 * decoding every candidate on every tick just to ask whether to skip it, and a
 * marker on the message would mean writing the metadata this sweep is otherwise
 * careful never to touch. It doubles as the query's bounding predicate, so a
 * pass over an install with nothing left to shrink matches no rows at all.
 *
 * Comfortably above what {@link SWEPT_MAX_DIMENSION_PX} at
 * {@link SWEPT_JPEG_QUALITY} produces (tens of KB), so a swept frame lands well
 * clear of the threshold rather than just under it.
 */
const SWEPT_MAX_BYTES = 128 * 1024;

/** Rows examined per pass, so one tick's work is bounded whatever the backlog. */
const SWEEP_BATCH_SIZE = 200;

/**
 * How often the sweep runs. The window it enforces is measured in days, so an
 * hourly cadence is far finer than the guarantee needs; it is what bounds the
 * cost of the pass, whose candidate query has no index to ride (neither
 * `attachments.created_at` nor `messages.metadata` carries one) and therefore
 * scans a table each time.
 */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Delay before the first pass. A desktop assistant is restarted often enough
 * that waiting a full interval could mean never sweeping at all, and startup is
 * already busy, so the first pass runs shortly after boot instead.
 */
const FIRST_SWEEP_DELAY_MS = 60_000;

let firstSweepTimer: ReturnType<typeof setTimeout> | null = null;
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let sweepInProgress = false;

/**
 * The workspace's `sight.sweepAfterDays`, clamped to
 * [{@link MIN_SIGHT_SWEEP_AFTER_DAYS}, {@link MAX_SIGHT_SWEEP_AFTER_DAYS}].
 *
 * Clamped at read rather than rejected by the schema, matching
 * `resolveSightKeepLatestFrames`: an out-of-range window states an intent the
 * guardrail can honor part of the way, while failing validation would silently
 * fall back to a default the config never asked for.
 */
export function resolveSightSweepAfterDays(): number {
  const configured = getConfig().sight.sweepAfterDays;
  if (!Number.isFinite(configured)) {
    return SWEEP_SIGHT_FRAMES_AFTER_DAYS;
  }
  return Math.min(
    MAX_SIGHT_SWEEP_AFTER_DAYS,
    Math.max(MIN_SIGHT_SWEEP_AFTER_DAYS, Math.trunc(configured)),
  );
}

export interface SightFrameSweepResult {
  /** Frames whose stored bytes were replaced with a thumbnail. */
  shrunk: number;
  /** Freed bytes, counted as stored size before minus stored size after. */
  freedBytes: number;
  /** Candidates left alone: shared or foreign file, unreadable, or no smaller. */
  skipped: number;
}

function emptyResult(): SightFrameSweepResult {
  return { shrunk: 0, freedBytes: 0, skipped: 0 };
}

/**
 * Shrink one batch of aged camera frames. Never throws: a sweep that cannot run
 * is a sweep that runs next hour.
 */
export async function sweepAgedSightFrames(): Promise<SightFrameSweepResult> {
  if (!getDbMigrationReadiness().ready) {
    return emptyResult();
  }

  let candidates;
  try {
    candidates = selectSightFrameSweepCandidates({
      createdBefore: Date.now() - resolveSightSweepAfterDays() * MS_PER_DAY,
      largerThanBytes: SWEPT_MAX_BYTES,
      limit: SWEEP_BATCH_SIZE,
    });
  } catch (err) {
    log.warn({ err }, "Could not read aged camera frames");
    return emptyResult();
  }

  const result = emptyResult();
  for (const candidate of candidates) {
    try {
      const shrunkBytes = await shrinkOneFrame(candidate.id);
      if (shrunkBytes === null) {
        result.skipped += 1;
        continue;
      }
      result.shrunk += 1;
      result.freedBytes += candidate.sizeBytes - shrunkBytes;
    } catch (err) {
      result.skipped += 1;
      log.warn(
        { err, attachmentId: candidate.id },
        "Could not shrink an aged camera frame",
      );
    }
  }

  if (result.shrunk > 0) {
    log.info(result, "Shrank aged camera frames to thumbnail scale");
  }
  return result;
}

/**
 * Re-encode one frame and store the result, returning its new byte length, or
 * null when the frame was left exactly as it was.
 */
async function shrinkOneFrame(attachmentId: string): Promise<number | null> {
  const bytes = getAttachmentContent(attachmentId);
  if (!bytes) {
    return null;
  }
  // The same converter attachment ingress and transport optimization use, so
  // there is one encoder in the process and a swept frame is a JPEG every
  // client and provider already reads.
  const thumbnail = await convertImageToJpeg(bytes, {
    maxDimensionPx: SWEPT_MAX_DIMENSION_PX,
    quality: SWEPT_JPEG_QUALITY,
  });
  if (!thumbnail) {
    return null;
  }

  const outcome = shrinkAttachmentBytes(attachmentId, thumbnail, "image/jpeg");
  if (outcome !== "shrunk") {
    log.debug({ attachmentId, outcome }, "Left an aged camera frame alone");
    return null;
  }
  return thumbnail.length;
}

/** Start the periodic sweep. Idempotent. */
export function startSightFrameStorageSweep(): void {
  if (sweepTimer || firstSweepTimer) {
    return;
  }
  firstSweepTimer = setTimeout(() => {
    firstSweepTimer = null;
    void runSweepPass();
  }, FIRST_SWEEP_DELAY_MS);
  sweepTimer = setInterval(() => {
    void runSweepPass();
  }, SWEEP_INTERVAL_MS);
}

/** Stop the periodic sweep. Used in tests and shutdown. */
export function stopSightFrameStorageSweep(): void {
  if (firstSweepTimer) {
    clearTimeout(firstSweepTimer);
    firstSweepTimer = null;
  }
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  sweepInProgress = false;
}

/** One pass, skipped while the previous one is still re-encoding. */
async function runSweepPass(): Promise<void> {
  if (sweepInProgress) {
    return;
  }
  sweepInProgress = true;
  try {
    await sweepAgedSightFrames();
  } finally {
    sweepInProgress = false;
  }
}
