import { existsSync } from "node:fs";

import { getWorkspacePromptPath } from "../util/platform.js";

export interface OnboardingGreetingContext {
  tools: string[];
  tasks: string[];
  tone: string;
  userName?: string;
  assistantName?: string;
}

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

export function getCannedFirstGreeting(
  onboarding?: OnboardingGreetingContext,
): string {
  if (onboarding) {
    return buildPersonalizedGreeting(onboarding);
  }
  return CANNED_FIRST_GREETING;
}

const TASK_SUGGESTIONS: Record<string, string> = {
  "code-building": "help you build something",
  writing: "draft or edit some writing",
  research: "dig into a research question",
  "project-management": "help organize a project",
  scheduling: "sort out your schedule",
  personal: "help with something personal",
};

function buildPersonalizedGreeting(ctx: OnboardingGreetingContext): string {
  const professional = ctx.tone === "professional";

  const userName = ctx.userName?.trim();
  const assistantName = ctx.assistantName?.trim();

  const opener = userName
    ? professional
      ? `Hello, ${userName}.`
      : `Hey ${userName}!`
    : professional
      ? "Hello."
      : "Hey!";

  const intro = assistantName
    ? `I'm ${assistantName} — brand new and ready to learn how you work.`
    : "I'm brand new and ready to learn how you work.";

  const suggestions = ctx.tasks.map((t) => TASK_SUGGESTIONS[t]).filter(Boolean);

  let actionLine = "";
  if (suggestions.length === 1) {
    actionLine = `Ready to ${suggestions[0]} whenever you are.`;
  } else if (suggestions.length >= 2) {
    actionLine = professional
      ? `Ready to ${suggestions[0]} or ${suggestions[1]} - just say the word.`
      : `Ready to ${suggestions[0]}, or ${suggestions[1]} - just say the word.`;
  }

  if (!actionLine) {
    actionLine = professional
      ? "Tell me what you need."
      : "Throw something at me.";
  }

  return [opener, intro, actionLine].filter(Boolean).join(" ");
}
