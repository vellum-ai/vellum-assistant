import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { NOTIFICATION_AVATAR_HASH_PATTERN } from "@vellumai/ipc-contract";

/**
 * The notification avatar on disk, because the OS draws a notification's
 * sender image from a file: Windows toast XML points its app-logo slot at a
 * `file://` URI the shell reads after the toast is posted.
 *
 * The file is named by the avatar's SHA-256, so the same picture is written
 * once and re-used by every later notification, and a new avatar lands beside
 * the old one rather than replacing a file a live toast is still reading. The
 * name is only safe as a name if it is also true of the bytes, so the digest
 * is recomputed here rather than trusted: a mismatch throws and the caller
 * posts the app-icon toast. A cache entry counts as a hit only while its
 * length matches the bytes in hand, so a truncated or emptied file is
 * rewritten instead of served forever.
 *
 * Every hit stamps the file's mtime, which is what the prune orders by, so the
 * assistants actually being notified about keep their entries. A file younger
 * than {@link PRUNE_MIN_AGE_MS} is never pruned, because the post hands the OS
 * a path it reads afterwards.
 */

const DIRECTORY_NAME = "notification-avatars";

/** Enough for a handful of assistants; the rest are re-written on demand. */
const MAX_FILES = 16;

/**
 * How long a posted notification may still be reading its avatar off disk.
 * It covers the post itself, not how long the OS keeps the notification
 * around: a toast the Action Center holds for days re-reads nothing, and an
 * entry pruned under it simply loses its picture there.
 */
const PRUNE_MIN_AGE_MS = 10 * 60 * 1000;

const TEMPORARY_SUFFIX = ".tmp";

/**
 * Writes `avatarPng` to `<userDataDir>/notification-avatars/<avatarHash>.png`
 * unless it is already there intact, prunes the directory to the newest
 * {@link MAX_FILES} files, and returns the absolute path.
 *
 * Throws when `avatarHash` is not a lowercase hex SHA-256, or is not the
 * digest of `avatarPng`: it is the file name, so anything else could escape
 * the directory or serve one assistant's picture under another's name.
 * Callers treat a throw as "post the notification without an avatar".
 */
export const ensureNotificationAvatarFile = (
  userDataDir: string,
  avatarPng: Buffer,
  avatarHash: string,
): string => {
  if (!NOTIFICATION_AVATAR_HASH_PATTERN.test(avatarHash)) {
    throw new Error(
      "A notification avatar hash must be 64 lowercase hex characters",
    );
  }
  if (createHash("sha256").update(avatarPng).digest("hex") !== avatarHash) {
    throw new Error("A notification avatar hash must match its bytes");
  }
  const directory = path.join(userDataDir, DIRECTORY_NAME);
  const file = path.join(directory, `${avatarHash}.png`);
  if (touchIfIntact(file, avatarPng.length)) {
    return file;
  }
  mkdirSync(directory, { recursive: true });
  writeAtomically(file, avatarPng);
  // A file a live notification still holds open can refuse to be removed, and
  // that is no reason to throw away the avatar just written.
  try {
    pruneToNewest(directory);
  } catch {
    // Left for the next write to sweep.
  }
  return file;
};

/**
 * Whether `file` already holds the cached avatar, stamping its mtime when it
 * does so the prune orders by last use rather than by first write.
 *
 * The length has to match the bytes in hand: the cache is hash-addressed, so
 * equal lengths are the same picture, and a truncated or emptied file is a
 * miss to rewrite rather than a hit to serve.
 */
const touchIfIntact = (file: string, bytes: number): boolean => {
  try {
    if (statSync(file).size !== bytes) {
      return false;
    }
  } catch {
    return false;
  }
  // The stamp only orders the prune. Failing to write it (a read-only file, a
  // clock the OS refuses) costs the entry its place in that order, never the
  // hit itself.
  try {
    const now = new Date();
    utimesSync(file, now, now);
  } catch {
    // The entry keeps its old mtime.
  }
  return true;
};

/**
 * A partial `.png` would be served as a cache hit forever, so the bytes land
 * under a temporary name and only become the cache entry through a rename.
 */
const writeAtomically = (file: string, bytes: Buffer): void => {
  const temporary = `${file}.${process.pid}${TEMPORARY_SUFFIX}`;
  try {
    writeFileSync(temporary, bytes);
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
};

const pruneToNewest = (directory: string): void => {
  const now = Date.now();
  const entries = readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(full).mtimeMs;
    } catch {
      return [];
    }
    return [{ full, name, mtimeMs, age: now - mtimeMs }];
  });

  // A crashed write leaves its staging file behind, and nothing else ever
  // reads one, so an old `.tmp` is swept whatever the file count is.
  for (const stale of entries.filter(
    (entry) =>
      entry.name.endsWith(TEMPORARY_SUFFIX) && entry.age >= PRUNE_MIN_AGE_MS,
  )) {
    rmSync(stale.full, { force: true });
  }

  const cached = entries
    .filter((entry) => entry.name.endsWith(".png"))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const stale of cached.slice(MAX_FILES)) {
    if (stale.age >= PRUNE_MIN_AGE_MS) {
      rmSync(stale.full, { force: true });
    }
  }
};
