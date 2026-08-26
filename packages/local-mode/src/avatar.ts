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

function readAvatarImage(imagePath: string): LockfileAssistantAvatarResult {
  try {
    const stats = fs.statSync(imagePath);
    if (!stats.isFile()) {
      return { ok: false, error: "avatar image unreadable" };
    }
    if (stats.size > AVATAR_IMAGE_MAX_BYTES) {
      return { ok: false, error: "avatar image too large" };
    }
    const imageBase64 = fs.readFileSync(imagePath).toString("base64");
    return { ok: true, avatar: { kind: "image", imageBase64 } };
  } catch {
    return { ok: false, error: "avatar image unreadable" };
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
  const avatar = readWorkspaceAvatar(
    path.join(resolved.instanceDir, ".vellum", "workspace"),
  );
  switch (avatar.kind) {
    case "character":
      return { ok: true, avatar: { kind: "character", traits: avatar.traits } };
    case "image":
      return readAvatarImage(avatar.imagePath);
    case "none":
      return { ok: true, avatar: null };
  }
}
