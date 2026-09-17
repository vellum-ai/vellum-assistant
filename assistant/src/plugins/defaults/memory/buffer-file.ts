// ---------------------------------------------------------------------------
// Memory buffer file: the two writers of `memory/buffer.md`
// ---------------------------------------------------------------------------
//
// `memory/buffer.md` has exactly two writers, and both live here so the
// protocol between them has one home. `remember()` and the sweep job APPEND
// entries through `appendBufferAndArchive`. The consolidation job CONSUMES
// the entries it handed to a run through `consumeBufferEntries`, removing
// exactly those entries and nothing else. Everything else in the plugin
// reads the file. The entry format itself is owned by `buffer-format.ts`.
//
// The writers run in different processes: user turns append from the
// daemon, while consolidation (and its consume) runs in the memory jobs
// worker, and the sweep appends from the worker too. No in-process lock can
// order them, and the buffer must never be rewritten from a stale read: an
// entry appended between a reader's read and its write would be destroyed
// without ever being filed. The consumer therefore never trusts a read for
// longer than one synchronous stretch and never lets an append land where
// it cannot see it:
//
//   1. Open the file and keep the descriptor: it pins the inode the path
//      names at that moment (call it O).
//   2. Read O through that descriptor, remove the consumed entries from what
//      was read, write the remainder to a sibling temp file, and rename it
//      over the path. Steps 1 and 2 run synchronously, with no await, so
//      nothing in this process interleaves. From the rename on, the path
//      names a new inode (N) and every appender that opens the path lands
//      on N, where nothing is ever rewritten.
//   3. Drain: an appender that opened O before the rename still writes to O,
//      which the held descriptor keeps alive. Compare O's size against the
//      bytes read; copy anything beyond them onto the path (an append to N,
//      the same operation the appenders use). Drain once immediately, then
//      once more after a short grace window, and only then close O.
//
// What can still be lost: an appender whose `open` preceded the rename and
// whose `write` lands after the final drain. Both calls sit inside one
// synchronous `appendFileSync`, so that needs the appending process to be
// stopped between two adjacent syscalls for longer than the grace window (a
// debugger, SIGSTOP, or a multi-second scheduler stall). Machine sleep
// freezes both processes together and does not count. The other way out is
// the drain's own copy failing (disk full, an I/O error) on every retry;
// the descriptor cannot be held forever, so those bytes are then gone from
// the buffer and reported as unrecovered, and the entries survive only in
// the daily archive the same append wrote. Nothing after the rename throws:
// once the rename has committed the pass is consumed, and the result says
// so. If either residual ever proves reachable, the escalation is a
// short-held `wx` lock file taken by both writers around their synchronous
// critical sections (the idiom `substrate/consolidation-lock.ts` uses);
// the consume shape above does not change, only its critical section gains
// a guard.
//
// Ordering: consumption removes entries and copies the rest verbatim, so
// the file stays in append order except for a drained late append, which
// lands after any entry appended to N in the meantime. Readers only rely
// on the tail being recent, never on strict order, so that is harmless.
// The same holds if a late append's bytes were split across the two
// drains (a partial `write()` on a regular file, well below the residual
// above): the halves land in order on N, possibly with another appender's
// entry between them, so the entry is split rather than lost, and the
// next pass's snapshot selection treats an unterminated tail as
// in-flight.

import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  type BufferEntryLines,
  bufferEntryText,
  joinBufferEntries,
  splitBufferContent,
} from "./buffer-format.js";
import { getLogger } from "./logging.js";

const log = getLogger("memory-buffer-file");

/**
 * How long the consumer keeps the replaced inode open after the rename
 * before its final drain. Only an appender stalled between its `open` and
 * its `write` for longer than this can lose an entry; a healthy appender
 * completes both within microseconds.
 */
const LATE_APPEND_GRACE_MS = 500;

/** Attempts to copy late-appended bytes back before giving them up. */
const LATE_APPEND_COPY_ATTEMPTS = 3;
/** Wait between those attempts; disk pressure and I/O errors are often brief. */
const LATE_APPEND_COPY_RETRY_MS = 200;

/**
 * Append `entry` to `<rootDir>/buffer.md` and `<rootDir>/archive/<today>.md`,
 * creating the archive directory and seeding the archive header if missing.
 *
 * Returns the absolute paths of both files so callers can fan out follow-up
 * work.
 *
 * Shared by `remember()` and the background jobs (`sweep`, future LLM-driven
 * extractors) so every appender writes exactly the same format and
 * downstream consumers (consolidation, search) cannot tell them apart.
 */
export function appendBufferAndArchive(args: {
  rootDir: string;
  entry: string;
  now: Date;
}): { bufferPath: string; archivePath: string } {
  const { rootDir, entry, now } = args;
  const archiveDir = join(rootDir, "archive");
  mkdirSync(archiveDir, { recursive: true });

  const bufferPath = join(rootDir, "buffer.md");
  appendFileSync(bufferPath, entry, "utf-8");

  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const archivePath = join(archiveDir, `${yyyy}-${mm}-${dd}.md`);
  if (!existsSync(archivePath)) {
    const month = now.toLocaleString("en-US", { month: "short" });
    appendFileSync(
      archivePath,
      `# ${month} ${now.getDate()}, ${yyyy}\n\n`,
      "utf-8",
    );
  }
  appendFileSync(archivePath, entry, "utf-8");

  return { bufferPath, archivePath };
}

export interface ConsumeBufferEntriesResult {
  /** Consumed entries found in the live file and removed. */
  removed: number;
  /**
   * Consumed entries not present in the live file. Something other than an
   * appender rewrote the file during the run; the caller decides whether
   * that is worth a warning.
   */
  alreadyAbsent: number;
  /** Bytes appended to the replaced inode after the read and copied back. */
  lateAppendBytesRecovered: number;
  /**
   * Bytes appended to the replaced inode that could not be copied back
   * after every retry. The pass is consumed regardless (the rename had
   * committed); these entries remain only in the daily archive.
   */
  unrecoveredLateAppendBytes: number;
  /**
   * The replaced inode could not be inspected or read after the rename, so
   * any append that landed on it is unaccounted for (not even counted in
   * `unrecoveredLateAppendBytes`). The pass is consumed regardless.
   */
  lateAppendDrainFailed: boolean;
}

/**
 * Remove `consumed` from `bufferPath`, leaving every other entry in place.
 * Never throws once the rename has committed; see the result's
 * `unrecoveredLateAppendBytes`.
 *
 * Each consumed entry is matched by its exact text ({@link bufferEntryText})
 * against the live file, first occurrence, once per consumed entry, so an
 * identical fact appended during the run survives when the snapshot held
 * one copy. An entry that is absent from the live file is counted, never
 * searched for elsewhere. A missing file consumes nothing.
 *
 * The critical section (read through a pinned descriptor, rewrite via temp
 * file + rename) is synchronous; the drain of late appends to the replaced
 * inode follows, with a second drain after `lateAppendGraceMs`. See the
 * module header for why this is lossless and what the residual is.
 *
 * I/O failures other than a missing file throw: the caller (the
 * consolidation job) treats a failed consume as no progress and leaves the
 * buffer for the next pass rather than guessing at its state.
 */
export async function consumeBufferEntries(
  bufferPath: string,
  consumed: readonly BufferEntryLines[],
  options: { lateAppendGraceMs?: number } = {},
): Promise<ConsumeBufferEntriesResult> {
  const graceMs = options.lateAppendGraceMs ?? LATE_APPEND_GRACE_MS;
  const pending = consumed.map(bufferEntryText);

  let fd: number;
  try {
    fd = openSync(bufferPath, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        removed: 0,
        alreadyAbsent: pending.length,
        lateAppendBytesRecovered: 0,
        unrecoveredLateAppendBytes: 0,
        lateAppendDrainFailed: false,
      };
    }
    throw err;
  }

  try {
    // Synchronous critical section: nothing in this process runs between
    // the read and the rename.
    const before = readFileSync(fd);
    let drainedTo = before.length;
    const live = splitBufferContent(before.toString("utf-8"));
    const remaining: BufferEntryLines[] = [];
    let removed = 0;
    for (const entry of live) {
      const index = pending.indexOf(bufferEntryText(entry));
      if (index === -1) {
        remaining.push(entry);
        continue;
      }
      pending.splice(index, 1);
      removed += 1;
    }
    const tmpPath = join(
      dirname(bufferPath),
      `.buffer.md.${process.pid}.${Date.now()}.tmp`,
    );
    writeFileSync(tmpPath, joinBufferEntries(remaining), "utf-8");
    try {
      renameSync(tmpPath, bufferPath);
    } catch (err) {
      unlinkSafely(tmpPath);
      throw err;
    }

    // Drain: appends that landed on the replaced inode after the read. The
    // rename has committed, so from here nothing throws: a copy that fails
    // is retried, bytes that cannot be copied are reported, and a replaced
    // inode that cannot even be read is reported, all without raising.
    let lateAppendBytesRecovered = 0;
    let unrecoveredLateAppendBytes = 0;
    let lateAppendDrainFailed = false;
    // Copies through an explicit write loop so a retry resumes from the
    // first unwritten byte: an append that wrote part of the bytes before
    // failing (disk pressure) must not have its prefix appended twice.
    const copyBack = async (bytes: Buffer): Promise<void> => {
      let written = 0;
      for (let attempt = 1; ; attempt++) {
        try {
          const out = openSync(bufferPath, "a");
          try {
            while (written < bytes.length) {
              const n = writeSync(out, bytes, written, bytes.length - written);
              if (n <= 0) {
                // A regular file never returns a zero-byte write without an
                // error, but a spin here would wedge the worker with the
                // consolidation lock held; treat it as a failed attempt.
                throw new Error("writeSync made no progress");
              }
              written += n;
            }
          } finally {
            closeSync(out);
          }
          lateAppendBytesRecovered += bytes.length;
          return;
        } catch (err) {
          if (attempt >= LATE_APPEND_COPY_ATTEMPTS) {
            log.error(
              { err, bufferPath, bytes: bytes.length, written, attempt },
              "buffer consume: could not copy entries appended during the rewrite back into the buffer; giving up the rest",
            );
            lateAppendBytesRecovered += written;
            unrecoveredLateAppendBytes += bytes.length - written;
            return;
          }
          log.warn(
            { err, bufferPath, bytes: bytes.length, written, attempt },
            "buffer consume: copying late-appended entries failed; retrying from the first unwritten byte",
          );
          await new Promise((resolve) =>
            setTimeout(resolve, LATE_APPEND_COPY_RETRY_MS),
          );
        }
      }
    };
    const drain = async (): Promise<void> => {
      let late: Buffer;
      try {
        const size = fstatSync(fd).size;
        if (size <= drainedTo) {
          return;
        }
        late = Buffer.alloc(size - drainedTo);
        const read = readSync(fd, late, 0, late.length, drainedTo);
        late = late.subarray(0, read);
        drainedTo += read;
      } catch (err) {
        log.error(
          { err, bufferPath },
          "buffer consume: could not read the replaced inode for entries appended during the rewrite",
        );
        lateAppendDrainFailed = true;
        return;
      }
      await copyBack(late);
    };
    await drain();
    if (graceMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, graceMs));
    }
    if (!lateAppendDrainFailed) {
      await drain();
    }
    if (lateAppendBytesRecovered > 0) {
      log.info(
        { bufferPath, lateAppendBytesRecovered },
        "buffer consume: recovered entries appended during the rewrite",
      );
    }

    return {
      removed,
      alreadyAbsent: pending.length,
      lateAppendBytesRecovered,
      unrecoveredLateAppendBytes,
      lateAppendDrainFailed,
    };
  } finally {
    // After the rename, a failing close must not surface as a failure of
    // the consume: the pass is consumed and the drain has reported. Before
    // the rename, the original error is already propagating.
    try {
      closeSync(fd);
    } catch (err) {
      log.error(
        { err, bufferPath },
        "buffer consume: closing the replaced buffer inode failed",
      );
    }
  }
}

function unlinkSafely(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // best-effort cleanup of a temp file the rename never claimed
  }
}
