/**
 * Picks which default profile answers a turn that runs on the Auto profile.
 *
 * The agent loop asks TypeSafe's System One model (Jev) one choice question
 * over the user's latest message, with the recent conversation for context,
 * and pins the turn to the answer. Every other outcome (no managed Jev route,
 * provider error, timeout, an answer naming no candidate) pins the turn to
 * Balanced, which is also the Auto profile's own body, so a turn the router
 * cannot judge runs exactly as a Balanced turn would.
 */

import {
  AUTO_PROFILE_ROUTER_CALL_SITE,
  DEFAULT_PROFILE_KEYS,
  type DefaultProfileKey,
  isDefaultProfileKey,
} from "../config/default-profile-names.js";
import type { ProfileEntry } from "../config/schemas/llm.js";
import { askTypesafe } from "../providers/jev/ask.js";
import type { ContentBlock, Message, Provider } from "../providers/types.js";
import { getLogger } from "../util/logger.js";
import { safeStringSlice } from "../util/unicode.js";

const log = getLogger("auto-profile-router");

export const AUTO_PROFILE_FALLBACK: DefaultProfileKey = "balanced";

/**
 * The profile a turn runs on when the router cannot judge it: Balanced while
 * it is a candidate, else the first candidate the user left enabled, else
 * Balanced (the Auto body itself) when nothing is enabled.
 */
export function autoProfileFallback(
  candidates: readonly DefaultProfileKey[],
): DefaultProfileKey {
  if (candidates.includes(AUTO_PROFILE_FALLBACK)) {
    return AUTO_PROFILE_FALLBACK;
  }
  return candidates[0] ?? AUTO_PROFILE_FALLBACK;
}

/**
 * Budget before the turn proceeds on Balanced. The router runs before the
 * turn's first provider call, so a Jev outage costs at most this much
 * time-to-first-token per Auto turn and never blocks the reply. Jev's
 * measured round trip sits well under it (the voice judge runs on 800ms).
 */
export const AUTO_PROFILE_ROUTER_TIMEOUT_MS = 1_000;

const HISTORY_TURNS = 6;
const HISTORY_TURN_MAX_CHARS = 600;
const MESSAGE_MAX_CHARS = 4_000;

/**
 * What each default profile is for, phrased so the options exclude each
 * other. The picker copy on the profiles describes a tier to a person;
 * these describe the kind of message that belongs on it.
 */
const ROUTING_CRITERIA: Record<DefaultProfileKey, string> = {
  balanced:
    "Everyday requests: questions, drafting, summaries, ordinary coding, tasks that use tools. The choice when nothing else clearly applies.",
  "quality-optimized":
    "Hard problems: multi-step reasoning, subtle debugging, large or delicate code changes, careful analysis, writing where quality matters most.",
  "cost-optimized":
    "Simple, mechanical work: short factual answers, reformatting, extraction, small edits where a modest model is plenty.",
  "latency-optimized":
    "Quick conversational replies: greetings, acknowledgements, one-line answers where speed matters more than depth.",
};

const ROUTING_INSTRUCTIONS =
  "Which model profile should answer the user's latest message? Judge the work the reply needs, using the recent conversation to interpret short follow-ups. Pick the cheapest profile that will still produce a good answer.";

export type AutoProfileRouteOutcome =
  | "routed"
  | "unavailable"
  | "timeout"
  | "error"
  | "fallback";

export interface AutoProfileRoute {
  profile: DefaultProfileKey;
  outcome: AutoProfileRouteOutcome;
  /** Jev's confidence in the pick, when it answered. */
  confidence?: number;
  latencyMs: number;
}

/** A message's spoken text: its text blocks minus injected `<...>` blocks. */
export function plainTextOf(content: readonly ContentBlock[]): string {
  return content
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter(
      (text) => text.trim().length > 0 && !text.trimStart().startsWith("<"),
    )
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The router's view of the conversation: the last few turns as plain text,
 * without injected context blocks, tool traffic, or the current message
 * (which the router receives on its own).
 */
export function recentConversationForRouter(
  history: readonly Message[],
  userMessage: string,
): string {
  const lines: string[] = [];
  for (const message of history) {
    const text = plainTextOf(message.content);
    if (text.length === 0) {
      continue;
    }
    lines.push(
      `${message.role}: ${safeStringSlice(text, 0, HISTORY_TURN_MAX_CHARS)}`,
    );
  }
  const current = `user: ${userMessage.replace(/\s+/g, " ").trim()}`;
  if (lines.length > 0 && lines[lines.length - 1] === current) {
    lines.pop();
  }
  return lines.slice(-HISTORY_TURNS).join("\n");
}

/**
 * The default profiles the router may pick from: the ones the conversation
 * view offers and the user has not disabled.
 */
export function autoProfileCandidates(
  profiles: Readonly<Record<string, ProfileEntry>>,
): DefaultProfileKey[] {
  return DEFAULT_PROFILE_KEYS.filter((key) => {
    const entry = profiles[key];
    return entry != null && entry.status !== "disabled";
  });
}

/**
 * Route one turn. Never rejects: every failure returns the fallback profile.
 */
export async function routeAutoProfile(args: {
  conversationId: string;
  history: readonly Message[];
  userMessage: string;
  profiles: Readonly<Record<string, ProfileEntry>>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Provider resolver, injectable for tests. */
  resolveProvider?: () => Promise<Provider | null>;
}): Promise<AutoProfileRoute> {
  const userMessage = args.userMessage.trim();
  const candidates = autoProfileCandidates(args.profiles);
  const fallback = autoProfileFallback(candidates);
  // A choice needs two options; with fewer there is nothing to route.
  if (userMessage.length === 0 || candidates.length < 2) {
    return { profile: fallback, outcome: "fallback", latencyMs: 0 };
  }
  const criteria = Object.fromEntries(
    candidates.map((key) => [
      key,
      `${args.profiles[key]?.label ?? key}: ${ROUTING_CRITERIA[key]}`,
    ]),
  );
  const result = await askTypesafe({
    callSite: AUTO_PROFILE_ROUTER_CALL_SITE,
    conversationId: args.conversationId,
    state: {
      recent_conversation:
        recentConversationForRouter(args.history, userMessage) ||
        "(start of conversation)",
      latest_user_message: safeStringSlice(userMessage, 0, MESSAGE_MAX_CHARS),
    },
    questions: {
      profile: {
        type: "choice",
        instructions: ROUTING_INSTRUCTIONS,
        criteria,
      },
    },
    timeoutMs: args.timeoutMs ?? AUTO_PROFILE_ROUTER_TIMEOUT_MS,
    ...(args.signal ? { signal: args.signal } : {}),
    ...(args.resolveProvider ? { resolveProvider: args.resolveProvider } : {}),
  });
  if (result.outcome !== "answered") {
    return {
      profile: fallback,
      outcome: result.outcome,
      latencyMs: result.latencyMs,
    };
  }
  const answer = result.answers?.profile;
  const choice =
    typeof answer === "object" && answer !== null && "choice" in answer
      ? (answer as { choice?: unknown }).choice
      : undefined;
  const confidence =
    typeof answer === "object" && answer !== null && "confidence" in answer
      ? (answer as { confidence?: unknown }).confidence
      : undefined;
  if (
    typeof choice !== "string" ||
    !isDefaultProfileKey(choice) ||
    !candidates.includes(choice)
  ) {
    log.warn(
      { conversationId: args.conversationId, choice },
      "Auto profile router answered with no candidate profile",
    );
    return { profile: fallback, outcome: "error", latencyMs: result.latencyMs };
  }
  // Argmax with no confidence floor. A floor belongs here if flat
  // distributions turn out to send trivial messages to Quality.
  return {
    profile: choice,
    outcome: "routed",
    ...(typeof confidence === "number" ? { confidence } : {}),
    latencyMs: result.latencyMs,
  };
}
