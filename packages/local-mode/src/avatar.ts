import fs from "node:fs";
import path from "node:path";

import {
  readWorkspaceAvatar,
  type CharacterTraits,
} from "@vellumai/avatar-manifest";

import { resolveLockfileInstanceDir } from "./status";

/**
 * A lockfile assistant's avatar as read off its workspace by a host. `null`
 * covers every "nothing to show" case (no entry, no workspace, no avatar,
 * unreadable or oversized files). Structurally identical to
 * `LocalReadAssistantAvatarResult` in `@vellumai/ipc-contract`, which this
 * package cannot depend on; hosts return it straight over IPC/HTTP.
 */
export type LockfileAssistantAvatar =
  | { kind: "character"; traits: CharacterTraits }
  | { kind: "image"; imageBase64: string };

export type LockfileAssistantAvatarResult =
  | { ok: true; avatar: LockfileAssistantAvatar | null }
  | { ok: false; error: string };

export const AVATAR_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

function readAvatarImage(imagePath: string): LockfileAssistantAvatar | null {
  try {
    const stats = fs.statSync(imagePath);
    if (!stats.isFile() || stats.size > AVATAR_IMAGE_MAX_BYTES) {
      return null;
    }
    return {
      kind: "image",
      imageBase64: fs.readFileSync(imagePath).toString("base64"),
    };
  } catch {
    return null;
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
  const instanceDir = resolveLockfileInstanceDir(
    lockfilePaths,
    assistantId,
    env,
  );
  if (!instanceDir) {
    return { ok: true, avatar: null };
  }
  const avatar = readWorkspaceAvatar(
    path.join(instanceDir, ".vellum", "workspace"),
  );
  switch (avatar.kind) {
    case "character":
      return { ok: true, avatar: { kind: "character", traits: avatar.traits } };
    case "image":
      return { ok: true, avatar: readAvatarImage(avatar.imagePath) };
    case "none":
      return { ok: true, avatar: null };
  }
}
