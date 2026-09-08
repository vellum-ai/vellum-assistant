import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

/**
 * The notification avatar on disk, because the OS draws a notification's
 * sender image from a file: Windows toast XML points its app-logo slot at a
 * `file://` URI the shell reads after the toast is posted.
 *
 * The file is named by the avatar's SHA-256, so the same picture is written
 * once and re-used by every later notification, and a new avatar lands beside
 * the old one rather than replacing a file a live toast is still reading.
 */

const DIRECTORY_NAME = "notification-avatars";

/** Enough for a handful of assistants; the rest are re-written on demand. */
const MAX_FILES = 8;

const HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Writes `avatarPng` to `<userDataDir>/notification-avatars/<avatarHash>.png`
 * unless it is already there, prunes the directory to the newest
 * {@link MAX_FILES} files, and returns the absolute path.
 *
 * Throws when `avatarHash` is not a lowercase hex SHA-256: it is the file
 * name, so anything else could escape the directory.
 */
export const ensureNotificationAvatarFile = (
  userDataDir: string,
  avatarPng: Buffer,
  avatarHash: string,
): string => {
  if (!HASH_PATTERN.test(avatarHash)) {
    throw new Error(
      "A notification avatar hash must be 64 lowercase hex characters",
    );
  }
  const directory = path.join(userDataDir, DIRECTORY_NAME);
  const file = path.join(directory, `${avatarHash}.png`);
  if (existsSync(file)) {
    return file;
  }
  mkdirSync(directory, { recursive: true });
  writeAtomically(file, avatarPng);
  pruneToNewest(directory);
  return file;
};

/**
 * A partial `.png` would be served by the `existsSync` check above forever,
 * so the bytes land under a temporary name and only become the cache entry
 * through a rename.
 */
const writeAtomically = (file: string, bytes: Buffer): void => {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, bytes);
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
};

const pruneToNewest = (directory: string): void => {
  const files = readdirSync(directory)
    .filter((name) => name.endsWith(".png"))
    .map((name) => {
      const full = path.join(directory, name);
      return { full, mtimeMs: statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const stale of files.slice(MAX_FILES)) {
    rmSync(stale.full, { force: true });
  }
};
