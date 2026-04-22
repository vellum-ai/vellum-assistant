import { existsSync } from "node:fs";

import { getWorkspacePromptPath } from "../util/platform.js";

export interface OnboardingGreetingContext {
  tools: string[];
  tasks: string[];
  tone: string;
  userName?: string;
  assistantName?: string;
}

export const CANNED_FIRST_GREETING = [
  "Hey — brand new, no name, no memories, no idea who you are yet. I'll get sharper the more we work together.",
  "",
  "What can I do for you? Or I can ask you some questions to get started.",
].join("\n");

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

const TASK_PRIORITY: string[] = [
  "code-building",
  "project-management",
  "writing",
  "research",
  "scheduling",
  "personal",
];

interface Guess {
  text: string;
  preferredTools: string[];
}

const SINGLE_GUESSES: Record<string, Guess> = {
  "code-building": {
    text: "shipping something or debugging",
    preferredTools: ["github", "linear", "jira"],
  },
  writing: {
    text: "drafting something or cleaning up docs",
    preferredTools: ["notion", "google-drive", "apple-notes"],
  },
  research: {
    text: "digging into a topic or making sense of something",
    preferredTools: ["notion", "google-drive"],
  },
  "project-management": {
    text: "planning the week, writing a spec, or pushing something forward",
    preferredTools: ["notion", "linear", "google-drive"],
  },
  scheduling: {
    text: "planning the week or prepping for meetings",
    preferredTools: ["google-calendar", "outlook", "linear"],
  },
  personal: {
    text: "juggling travel, bills, or household stuff",
    preferredTools: ["gmail", "google-calendar", "apple-notes"],
  },
};

const COMBO_GUESSES: Record<string, Guess> = {
  "code-building+project-management": {
    text: "shipping code or figuring out what to ship next",
    preferredTools: ["github", "linear", "jira"],
  },
  "code-building+writing": {
    text: "shipping code or writing something up",
    preferredTools: ["github", "linear", "jira"],
  },
  "project-management+writing": {
    text: "writing a spec or pushing something forward",
    preferredTools: ["notion", "linear", "google-drive"],
  },
  "research+writing": {
    text: "drafting something or digging into a topic",
    preferredTools: ["notion", "google-drive"],
  },
  "project-management+scheduling": {
    text: "planning the week or prepping for something",
    preferredTools: ["google-calendar", "outlook", "linear"],
  },
};

function comboKey(a: string, b: string): string {
  return [a, b].sort().join("+");
}

function highestPriorityTask(tasks: string[]): string | undefined {
  for (const t of TASK_PRIORITY) {
    if (tasks.includes(t)) return t;
  }
  return tasks[0];
}

function buildIntroLine(userName?: string, assistantName?: string): string {
  const namepart = userName ? `Hey ${userName},` : "Hey,";
  const who = assistantName
    ? `I'm ${assistantName}. Brand new, and I'll get sharper the more we work together.`
    : "brand new, and I'll get sharper the more we work together.";
  return `${namepart} ${who}`;
}

function pickRelevantTools(
  preferredTools: string[],
  userTools: string[],
): string[] {
  const userSet = new Set(userTools);
  const matched: string[] = [];
  for (const t of preferredTools) {
    if (userSet.has(t)) {
      matched.push(TOOL_LABELS[t] ?? t);
      if (matched.length === 2) break;
    }
  }
  return matched;
}

function buildSpecificGuess(tasks: string[], tools: string[]): string {
  let guess: Guess | undefined;

  if (tasks.length === 2) {
    guess = COMBO_GUESSES[comboKey(tasks[0], tasks[1])];
  }

  if (!guess) {
    const top = highestPriorityTask(tasks);
    guess = top ? SINGLE_GUESSES[top] : undefined;
  }

  if (!guess) return "";

  const relevant = pickRelevantTools(guess.preferredTools, tools);

  if (relevant.length === 2) {
    return `Your ${relevant[0]} and ${relevant[1]} say you're probably ${guess.text} — am I on the right track, or something else on your mind?`;
  }
  if (relevant.length === 1) {
    return `Your ${relevant[0]} says you're probably ${guess.text} — am I on the right track, or something else on your mind?`;
  }

  return `Probably ${guess.text} — am I on the right track, or something else on your mind?`;
}

function buildPersonalizedGreeting(ctx: OnboardingGreetingContext): string {
  const userName = ctx.userName?.trim();
  const assistantName = ctx.assistantName?.trim();

  const hasName = userName && userName.length > 0;
  const hasTasks = ctx.tasks.length > 0;
  const hasTools = ctx.tools.length > 0;

  if (!hasName && !hasTasks && !hasTools) {
    return CANNED_FIRST_GREETING;
  }

  const intro = buildIntroLine(hasName ? userName : undefined, assistantName);

  let secondParagraph: string;

  if (ctx.tasks.length >= 4) {
    secondParagraph =
      "Looks like you wear a lot of hats. Where should we start?";
  } else if (ctx.tasks.length === 0) {
    secondParagraph =
      "What's on your plate? Or if it's easier, I can ask you a few questions to get oriented.";
  } else {
    secondParagraph = buildSpecificGuess(ctx.tasks, ctx.tools);
  }

  return [intro, "", secondParagraph].join("\n");
}
