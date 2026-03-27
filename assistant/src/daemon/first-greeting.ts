import { existsSync } from "node:fs";

import { getWorkspacePromptPath } from "../util/platform.js";

/**
 * The canned assistant response for the wake-up greeting on a fresh workspace.
 * Warm, non-presumptuous greeting that communicates "I'm new," "I improve over
 * time," "I'm ready to be useful," and "you're in control."
 */
export const CANNED_FIRST_GREETING =
  "Hey. I'm brand new, no name, no memories, nothing yet. The more we work together, the more context and memory I build, and the better I get. But let's not wait around. Throw a question at me, give me a task, or ask what I can do.";

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
