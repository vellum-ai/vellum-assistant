/**
 * Projection from model-native assistant content to what a user reads.
 *
 * On a turn that routed its reply through `send_user_message` the two swap
 * roles: the model's plain text is a private scratchpad and each
 * `send_user_message` call is the reply. The projection states that swap once,
 * as a pure function over content blocks, so every reader that decides what a
 * user sees (history rendering, channel delivery, push previews) agrees on the
 * answer.
 *
 * Whether a row swaps is a property OF THE ROW, not of the live flag: the turn
 * that wrote it stamps {@link ASSISTANT_TEXT_VISIBILITY_KEY} on the row's
 * metadata, and only a row marked `"private"` projects. A row from a call,
 * a subagent, a live-voice leg, a fallback turn that surfaced its raw text, or
 * any turn written while the flag was off carries no marker and is untouched
 * by construction. Turning the flag off later therefore cannot rewrite history
 * that was already delivered, and turning it on cannot hide text that was.
 *
 * The persisted row and the model-native history are left alone: the model
 * must still see its own scratchpad when a conversation resumes. Only the
 * read-side projection moves the text.
 */

import { SEND_USER_MESSAGE_TOOL_NAME } from "../../config/send-user-message-gate.js";
import type { ContentBlock } from "../../providers/types.js";

/**
 * Whether an assistant row's plain text was shown to the user.
 *
 * - `"private"`: the turn routed its reply through `send_user_message`, so the
 *   text is working notes the user never saw.
 * - `"visible"`: the turn ran under the tool gate but ended without ever
 *   calling the tool, so the loop surfaced the raw text as the fallback. The
 *   user saw it, so history and channel delivery must carry it.
 *
 * Absent on every other row (the shipped behavior: streamed assistant text).
 */
export type AssistantTextVisibility = "private" | "visible";

/** Metadata key carrying {@link AssistantTextVisibility} on an assistant row. */
export const ASSISTANT_TEXT_VISIBILITY_KEY = "assistantTextVisibility";

export interface UserFacingProjectionOptions {
  /**
   * Whether this content's plain text is private working notes. False returns
   * the content untouched, which is the shipped behavior.
   */
  toolGated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Read {@link ASSISTANT_TEXT_VISIBILITY_KEY} off a persisted row's metadata,
 * which reaches readers either as the raw JSON string or already parsed.
 * Anything unreadable answers "no marker", so a malformed envelope degrades to
 * the shipped rendering rather than hiding a reply.
 */
export function assistantTextVisibilityOf(
  metadata: unknown,
): AssistantTextVisibility | undefined {
  let parsed: unknown = metadata;
  if (typeof metadata === "string") {
    try {
      parsed = JSON.parse(metadata);
    } catch {
      return undefined;
    }
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  const value = parsed[ASSISTANT_TEXT_VISIBILITY_KEY];
  return value === "private" || value === "visible" ? value : undefined;
}

/**
 * Whether a row's plain text is private working notes, and so must be
 * projected before anything shows it to a user.
 */
export function isPrivateAssistantText(metadata: unknown): boolean {
  return assistantTextVisibilityOf(metadata) === "private";
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
 * parsed blocks) for a user-facing read, keyed on the row's own metadata
 * marker. Anything that does not parse into blocks is returned untouched, so a
 * legacy string row behaves exactly as it does today.
 */
export function projectPersistedAssistantContent(
  stored: string | ContentBlock[],
  metadata: unknown,
): string | ContentBlock[] {
  if (!isPrivateAssistantText(metadata)) {
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
