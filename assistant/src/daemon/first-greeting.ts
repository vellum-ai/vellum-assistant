import { existsSync } from "node:fs";

import { getWorkspacePromptPath } from "../util/platform.js";

/**
 * The canned assistant response for the wake-up greeting on a fresh workspace.
 * Warm, non-presumptuous greeting that communicates "I'm new," "I improve over
 * time," and invites the user to lead with whatever they want — a task, a
 * question, or getting to know each other.
 */
export const CANNED_FIRST_GREETING =
  "Hey — I'm brand new. No name, no memories, no idea who you are yet. I'll get sharper the more we work together. What can I do for you?";

/**
 * Returns `true` when all of the following are true:
 * - `conversationMessageCount === 0` (no prior messages in this conversation)
 * - BOOTSTRAP.md exists at the workspace prompt path
 * - The trimmed content matches the macOS wake-up greeting (case-insensitive)
 */
export function isWakeUpGreeting(
  content: string,
  conversationMessageCount: number,
): boolean {
  if (conversationMessageCount !== 0) return false;
  if (!existsSync(getWorkspacePromptPath("BOOTSTRAP.md"))) return false;
  return (
    content
      .trim()
      .toLowerCase()
      .replace(/[.!?]+$/, "") === "wake up, my friend"
  );
}

/**
 * Returns the canned first-greeting string. Simple getter that exists to keep
 * the call site consistent and allow future flexibility (e.g., locale-aware
 * greetings) without changing the API.
 */
export function getCannedFirstGreeting(): string {
  return CANNED_FIRST_GREETING;
}
