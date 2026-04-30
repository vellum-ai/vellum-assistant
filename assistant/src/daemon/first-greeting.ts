import { existsSync } from "node:fs";

import { getWorkspacePromptPath } from "../util/platform.js";

type Tone = "grounded" | "warm" | "energetic" | "poetic";

export interface OnboardingGreetingContext {
  tools: string[];
  tasks: string[];
  /** Valid values: "grounded" | "warm" | "energetic" | "poetic" */
  tone: string;
  userName?: string;
  assistantName?: string;
}

export const CANNED_FIRST_GREETING = [
  "Hey,",
  "",
  "We can get into whatever you've got, or just talk first — that tends to go better. Up to you.",
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

const TONE_INTRO_CLOSE: Record<Tone, string> = {
  grounded: "",
  warm: "Good to meet you.",
  energetic: "Let's see what you've got.",
  poetic: "",
};

function buildIntroLine(
  name?: string,
  assistant?: string,
  tone: Tone = "grounded",
): string {
  const greeting = name ? `Hey ${name},` : "Hey,";
  const who = assistant ? `I'm ${assistant}.` : "";
  const close = assistant ? TONE_INTRO_CLOSE[tone] : "";
  return [greeting, who, close].filter(Boolean).join(" ");
}

const TONE_INVITE: Record<Tone, string> = {
  grounded:
    "We can get into whatever you've got, or just talk first — that tends to go better. Up to you.",
  warm: "We can start on something specific, or just talk for a bit first — honestly that tends to work out better. Either way, I'm here.",
  energetic:
    "We can jump straight into whatever you've got, or take a few minutes to just talk first. What sounds right?",
  poetic:
    "We can start with whatever's in front of you, or just talk for a bit first. Either way.",
};

function buildInvite(tone: Tone = "grounded"): string {
  return TONE_INVITE[tone];
}

const VALID_TONES = new Set<string>([
  "grounded",
  "warm",
  "energetic",
  "poetic",
]);

function resolveTone(raw?: string): Tone {
  return raw && VALID_TONES.has(raw) ? (raw as Tone) : "grounded";
}

function buildPersonalizedGreeting(ctx: OnboardingGreetingContext): string {
  const name = ctx.userName?.trim();
  const assistant = ctx.assistantName?.trim();
  const tone = resolveTone(ctx.tone);

  if (!name && !assistant && !VALID_TONES.has(ctx.tone)) {
    return CANNED_FIRST_GREETING;
  }

  const intro = buildIntroLine(name, assistant, tone);
  const invite = buildInvite(tone);
  return [intro, "", invite].join("\n");
}
