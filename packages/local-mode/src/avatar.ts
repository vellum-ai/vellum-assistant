import fs from "node:fs";
import path from "node:path";

import {
  readWorkspaceAvatar,
  type CharacterTraits,
} from "@vellumai/avatar-manifest";

import { resolveLockfileInstanceDir } from "./status";

/**
 * A lockfile assistant's avatar as read off its workspace by a host.
 * `{ ok: true, avatar: null }` is a conclusive absence (no entry, no
 * workspace, no avatar); an unreadable lockfile, or a file the manifest
 * points at but the host cannot serve (unreadable, oversized), is `ok: false`
 * so callers keep their last-seen avatar. Structurally identical to
 * `LocalReadAssistantAvatarResult` in `@vellumai/ipc-contract`, which this
 * package cannot depend on; hosts return it straight over IPC/HTTP.
 */
type LockfileAssistantAvatar =
  | { kind: "character"; traits: CharacterTraits }
  | { kind: "image"; imageBase64: string };

type LockfileAssistantAvatarResult =
  | { ok: true; avatar: LockfileAssistantAvatar | null }
  | { ok: false; error: string };

const AVATAR_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

function isBeneath(dir: string, filePath: string): boolean {
  const rel = path.relative(dir, filePath);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Serve only a regular file that truly lives under the workspace: a symlinked
 * PNG (or a symlinked ancestor) would let the workspace hand the renderer an
 * arbitrary host file. Validation and the read share one descriptor so a
 * concurrent swap of the path cannot slip a different file past the checks,
 * and the opened descriptor's location is revalidated after the open.
 */
function readAvatarImage(
  workspaceDir: string,
  imagePath: string,
): LockfileAssistantAvatarResult {
  let fd: number | undefined;
  try {
    const realDir = fs.realpathSync(path.dirname(imagePath));
    if (!isBeneath(fs.realpathSync(workspaceDir), realDir)) {
      return { ok: false, error: "avatar image unreadable" };
    }
    const realPath = path.join(realDir, path.basename(imagePath));
    const linkStats = fs.lstatSync(realPath);
    if (!linkStats.isFile()) {
      return { ok: false, error: "avatar image unreadable" };
    }
    fd = fs.openSync(
      realPath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const stats = fs.fstatSync(fd);
    if (
      !stats.isFile() ||
      stats.dev !== linkStats.dev ||
      stats.ino !== linkStats.ino
    ) {
      return { ok: false, error: "avatar image unreadable" };
    }
    // O_NOFOLLOW guards only the last component; an ancestor swapped for an
    // outside symlink between the check and the open either stays swapped
    // (fresh realpath resolves outside) or is swapped back (the inside file
    // is a different inode than the opened fd). Node has no openat.
    const reopenedPath = fs.realpathSync(imagePath);
    if (!isBeneath(fs.realpathSync(workspaceDir), reopenedPath)) {
      return { ok: false, error: "avatar image unreadable" };
    }
    const reopenedStats = fs.lstatSync(reopenedPath);
    if (
      !reopenedStats.isFile() ||
      reopenedStats.dev !== stats.dev ||
      reopenedStats.ino !== stats.ino
    ) {
      return { ok: false, error: "avatar image unreadable" };
    }
    if (stats.size > AVATAR_IMAGE_MAX_BYTES) {
      return { ok: false, error: "avatar image too large" };
    }
    const image = fs.readFileSync(fd);
    if (image.length > AVATAR_IMAGE_MAX_BYTES) {
      return { ok: false, error: "avatar image too large" };
    }
    return {
      ok: true,
      avatar: { kind: "image", imageBase64: image.toString("base64") },
    };
  } catch {
    return { ok: false, error: "avatar image unreadable" };
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

/**
 * Read an assistant's avatar directly off disk via its lockfile instance dir,
 * so a sleeping sibling assistant still has an avatar in the chooser. Shared
 * by the Electron IPC handler and the Vite dev middleware so every host
 * applies one size policy and one result shape.
 */
export function readLockfileAssistantAvatar(
  lockfilePaths: string[],
  assistantId: string,
  env: Record<string, string | undefined>,
): LockfileAssistantAvatarResult {
  const resolved = resolveLockfileInstanceDir(lockfilePaths, assistantId, env);
  if (!resolved.ok) {
    return { ok: false, error: "lockfile unreadable" };
  }
  if (!resolved.instanceDir) {
    return { ok: true, avatar: null };
  }
  const workspaceDir = path.join(resolved.instanceDir, ".vellum", "workspace");
  const avatar = readWorkspaceAvatar(workspaceDir);
  switch (avatar.kind) {
    case "character":
      return { ok: true, avatar: { kind: "character", traits: avatar.traits } };
    case "image":
      return readAvatarImage(workspaceDir, avatar.imagePath);
    case "none":
      return { ok: true, avatar: null };
  }
}
