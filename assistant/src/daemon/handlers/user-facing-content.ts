/**
 * Projection from model-native assistant content to what a user reads.
 *
 * Under the `send-user-message` flag the two swap roles: the model's plain
 * text is a private scratchpad and each `send_user_message` call is the reply.
 * The projection states that swap once, as a pure function over content
 * blocks, so every reader that decides what a user sees (history rendering,
 * channel delivery, push previews, wake output inspection) agrees on the
 * answer.
 *
 * The persisted row and the model-native history are left alone: the model
 * must still see its own scratchpad when a conversation resumes. Only the
 * read-side projection moves the text.
 */

import {
  isSendUserMessageFlagOn,
  SEND_USER_MESSAGE_TOOL_NAME,
} from "../../config/send-user-message-gate.js";
import type { ContentBlock } from "../../providers/types.js";

export interface UserFacingProjectionOptions {
  /**
   * Whether this content was produced under the tool-gated reply surface.
   * False returns the content untouched, which is the shipped behavior.
   */
  toolGated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The user-facing text a `send_user_message` call carries, or null when the
 * block is not one (or carries no usable message).
 */
export function sendUserMessageText(block: unknown): string | null {
  if (!isRecord(block) || block["type"] !== "tool_use") {
    return null;
  }
  if (block["name"] !== SEND_USER_MESSAGE_TOOL_NAME) {
    return null;
  }
  const input = block["input"];
  if (!isRecord(input)) {
    return null;
  }
  const message = input["message"];
  if (typeof message !== "string" || message.trim().length === 0) {
    return null;
  }
  return message;
}

/** Whether any block in the content is a usable `send_user_message` call. */
export function hasSendUserMessageCall(content: unknown): boolean {
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((block) => sendUserMessageText(block) !== null);
}

/**
 * Project assistant content into what the user reads. Text blocks become
 * thinking blocks (private working notes) and each `send_user_message` call
 * becomes the text block carrying its message. Every other block passes
 * through untouched, and a `send_user_message` call with no usable message is
 * left as-is so nothing is silently dropped.
 */
export function projectUserFacingContent(
  content: ContentBlock[],
  opts: UserFacingProjectionOptions,
): ContentBlock[];
export function projectUserFacingContent(
  content: unknown,
  opts: UserFacingProjectionOptions,
): unknown;
export function projectUserFacingContent(
  content: unknown,
  opts: UserFacingProjectionOptions,
): unknown {
  if (!opts.toolGated || !Array.isArray(content)) {
    return content;
  }

  let changed = false;
  const projected = content.map((block) => {
    if (isRecord(block) && block["type"] === "text") {
      changed = true;
      return {
        type: "thinking",
        thinking: typeof block["text"] === "string" ? block["text"] : "",
        signature: "",
      };
    }
    const message = sendUserMessageText(block);
    if (message !== null) {
      changed = true;
      return { type: "text", text: message };
    }
    return block;
  });

  return changed ? projected : content;
}

/**
 * Project a persisted assistant row's stored content (JSON text or already
 * parsed blocks) for a user-facing read, honoring the live flag. Anything that
 * does not parse into blocks is returned untouched, so a legacy string row
 * behaves exactly as it does today.
 */
export function projectPersistedAssistantContent(
  stored: string | ContentBlock[],
): string | ContentBlock[] {
  if (!isSendUserMessageFlagOn()) {
    return stored;
  }
  if (Array.isArray(stored)) {
    return projectUserFacingContent(stored, { toolGated: true });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return stored;
  }
  if (!Array.isArray(parsed)) {
    return stored;
  }
  return projectUserFacingContent(parsed as ContentBlock[], {
    toolGated: true,
  });
}
