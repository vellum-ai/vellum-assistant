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

const TOOL_LABELS: Record<string, string> = {
  gmail: "Gmail",
  outlook: "Outlook",
  "google-calendar": "Google Calendar",
  slack: "Slack",
  notion: "Notion",
  linear: "Linear",
  jira: "Jira",
  github: "GitHub",
  figma: "Figma",
  "google-drive": "Google Drive",
  excel: "Excel",
  "apple-notes": "Apple Notes",
};

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

  const toolNames = ctx.tools.map((t) => TOOL_LABELS[t] ?? t).filter(Boolean);

  let toolLine = "";
  if (toolNames.length > 0) {
    const list =
      toolNames.length <= 3
        ? toolNames.join(", ")
        : `${toolNames.slice(0, 2).join(", ")}, and ${toolNames.length - 2} more`;
    toolLine = professional
      ? `I see you work with ${list} — good to know.`
      : `I see you use ${list} — noted.`;
  }

  const suggestions = ctx.tasks.map((t) => TASK_SUGGESTIONS[t]).filter(Boolean);

  let actionLine = "";
  if (suggestions.length === 1) {
    actionLine = `Want me to ${suggestions[0]}?`;
  } else if (suggestions.length >= 2) {
    actionLine = professional
      ? `I can ${suggestions[0]} or ${suggestions[1]} — which sounds useful?`
      : `I could ${suggestions[0]}, or ${suggestions[1]} — what sounds good?`;
  }

  if (!actionLine) {
    actionLine = professional
      ? "What would be most useful to start with?"
      : "What should we tackle first?";
  }

  return [opener, intro, toolLine, actionLine].filter(Boolean).join(" ");
}
