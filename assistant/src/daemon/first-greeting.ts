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

const TOOL_ENHANCED_SUGGESTIONS: Record<string, Record<string, string>> = {
  "code-building": {
    github: "review your open PRs or help build something",
    _default: "help you build something",
  },
  writing: {
    gmail: "triage your inbox or draft something",
    notion: "draft or clean up something in Notion",
    _default: "draft or edit some writing",
  },
  research: {
    _default: "dig into a research topic and give you a summary",
  },
  "project-management": {
    linear: "pull your Linear board and help plan what's next",
    jira: "pull your Jira board and help plan what's next",
    notion: "help organize a project in Notion",
    _default: "help organize a project",
  },
  scheduling: {
    "google-calendar": "look at your calendar and plan your day",
    _default: "sort out your schedule",
  },
  personal: {
    _default: "help with something personal",
  },
};

function getSuggestion(task: string, tools: Set<string>): string | undefined {
  const variants = TOOL_ENHANCED_SUGGESTIONS[task];
  if (!variants) return undefined;
  for (const tool of Object.keys(variants)) {
    if (tool !== "_default" && tools.has(tool)) return variants[tool];
  }
  return variants._default;
}

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
    ? `I'm ${assistantName}, brand new and ready to learn how you work.`
    : "I'm brand new and ready to learn how you work.";

  const toolSet = new Set(ctx.tools);
  const allSuggestions = ctx.tasks
    .map((t) => {
      const text = getSuggestion(t, toolSet);
      if (!text) return undefined;
      const enhanced = TOOL_ENHANCED_SUGGESTIONS[t]
        ? Object.keys(TOOL_ENHANCED_SUGGESTIONS[t]).some(
            (k) => k !== "_default" && toolSet.has(k),
          )
        : false;
      return { text, enhanced };
    })
    .filter(Boolean) as { text: string; enhanced: boolean }[];

  allSuggestions.sort((a, b) => (b.enhanced ? 1 : 0) - (a.enhanced ? 1 : 0));
  const suggestions = allSuggestions.slice(0, 2).map((s) => s.text);

  let offerLine = "";
  if (suggestions.length === 1) {
    offerLine = `I can ${suggestions[0]}, and a lot more.`;
  } else if (suggestions.length === 2) {
    offerLine = `I can ${suggestions[0]}, ${suggestions[1]}, and a lot more.`;
  }

  const closing = professional
    ? "Tell me what you're working on and let's get started."
    : "Tell me what you're working on and let's get started.";

  return [opener, intro, offerLine, closing].filter(Boolean).join(" ");
}
