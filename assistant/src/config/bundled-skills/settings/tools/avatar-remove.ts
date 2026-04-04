import { existsSync, unlinkSync } from "node:fs";

import { buildAssistantEvent } from "../../../../runtime/assistant-event.js";
import { assistantEventHub } from "../../../../runtime/assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../../../../runtime/assistant-scope.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { getLogger } from "../../../../util/logger.js";
import { getAvatarImagePath } from "../../../../util/platform.js";
import { updateIdentityAvatarSection } from "./identity-avatar.js";

const log = getLogger("avatar-remove");

export async function run(
  _input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const avatarPath = getAvatarImagePath();

  if (!existsSync(avatarPath)) {
    return {
      content: "No custom avatar to remove — already using the default.",
      isError: false,
    };
  }

  try {
    unlinkSync(avatarPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ error: message }, "Failed to remove avatar image");
    return { content: `Error removing avatar: ${message}`, isError: true };
  }

  // character-traits.json is intentionally preserved so the native
  // character avatar is restored automatically.

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

  // Update IDENTITY.md to reflect the avatar was removed.
  updateIdentityAvatarSection(
    "Default character avatar (no custom image set)",
    log,
  );

  log.info("Custom avatar removed, reverting to character avatar");

  return {
    content: "Custom avatar removed. The character avatar has been restored.",
    isError: false,
  };
}
