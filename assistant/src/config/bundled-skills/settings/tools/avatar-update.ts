import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { buildAssistantEvent } from "../../../../runtime/assistant-event.js";
import { assistantEventHub } from "../../../../runtime/assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../../../../runtime/assistant-scope.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { getLogger } from "../../../../util/logger.js";
import { getWorkspaceDir } from "../../../../util/platform.js";
import { updateIdentityAvatarSection } from "./identity-avatar.js";

const log = getLogger("avatar-update");

/** Canonical path where the custom avatar PNG is stored. */
function getAvatarPath(): string {
  return join(getWorkspaceDir(), "data", "avatar", "avatar-image.png");
}

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const sourcePath = input.image_path as string | undefined;

  if (!sourcePath || typeof sourcePath !== "string") {
    return {
      content:
        'Error: "image_path" is required. Provide the path to the image file (absolute or relative to workspace).',
      isError: true,
    };
  }

  const workspaceDir = getWorkspaceDir();
  const resolvedSource = sourcePath.startsWith("/")
    ? sourcePath
    : join(workspaceDir, sourcePath);

  if (!existsSync(resolvedSource)) {
    return {
      content: `Error: source file not found: ${resolvedSource}`,
      isError: true,
    };
  }

  const avatarPath = getAvatarPath();
  const avatarDir = dirname(avatarPath);

  try {
    mkdirSync(avatarDir, { recursive: true });
    copyFileSync(resolvedSource, avatarPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ error: message }, "Failed to copy avatar image");
    return { content: `Error copying avatar: ${message}`, isError: true };
  }

  // Keep character-traits.json and character-ascii.txt so the character
  // avatar can be restored if the custom image is later removed.

  // Notify connected clients so the avatar refreshes immediately.
  assistantEventHub
    .publish(
      buildAssistantEvent(DAEMON_INTERNAL_ASSISTANT_ID, {
        type: "avatar_updated",
        avatarPath,
      }),
    )
    .catch((err) => {
      log.warn({ err }, "Failed to publish avatar_updated event");
    });

  // Clear any stale avatar description from IDENTITY.md so the assistant
  // is prompted to describe the new image on next read.
  updateIdentityAvatarSection(null, log);

  log.info({ avatarPath, source: resolvedSource }, "Avatar updated");

  return {
    content: `Avatar updated from ${sourcePath}. The app will refresh automatically. The avatar description in IDENTITY.md has been cleared — describe what the new avatar looks like by updating the ## Avatar section in IDENTITY.md with a plain-text description (not an image link).`,
    isError: false,
  };
}
