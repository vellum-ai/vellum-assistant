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

import { getConversationProfilesForProvider } from "../config/default-profile-catalog.js";
import {
  AUTO_PROFILE_KEY,
  AUTO_PROFILE_ROUTER_CALL_SITE,
  DEFAULT_PROFILE_KEYS,
  type DefaultProfileKey,
  isDefaultProfileKey,
} from "../config/default-profile-names.js";
import { getConfig } from "../config/loader.js";
import type { ProfileEntry } from "../config/schemas/llm.js";
import { getMessagesPaginated } from "../persistence/conversation-crud.js";
import { resolveConversationId } from "../persistence/conversation-key-store.js";
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

// ---------------------------------------------------------------------------
// Draft preview and send-time reuse
// ---------------------------------------------------------------------------

/**
 * How long a draft preview stays reusable by the turn that sends the same
 * text. Long enough to cover the pause between the preview and the send,
 * short enough that a stale pick never outlives the draft it was made for.
 */
export const AUTO_PROFILE_PREVIEW_REUSE_MS = 60_000;

/** Recent history rows the preview shows the router, matching the turn's window. */
const PREVIEW_HISTORY_ROWS = 12;

/** Cache key for a preview made before the conversation has a server id. */
const NO_CONVERSATION_KEY = "*";

interface RememberedPreview {
  text: string;
  /** What the router saw besides the text: the candidate set and the last
   *  line of recent history. A send whose context differs re-routes. */
  context: string;
  route: AutoProfileRoute;
  at: number;
}

/**
 * Bound on remembered previews. Abandoned drafts never get taken, so
 * expiry alone would let the map grow with every conversation ever
 * previewed; oldest entries go first once the bound is reached.
 */
const MAX_REMEMBERED_PREVIEWS = 200;

const rememberedPreviews = new Map<string, RememberedPreview>();

function normalizeDraft(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The routing inputs other than the draft, reduced to a comparable string:
 * which profiles were candidates, and the last line of history the router
 * saw. Both sides (preview from persisted rows, turn from the live history)
 * render history through `recentConversationForRouter`, so the last line
 * agrees whenever the conversation has not moved.
 */
export function autoProfilePreviewContext(
  history: readonly Message[],
  userMessage: string,
  candidates: readonly DefaultProfileKey[],
): string {
  const rendered = recentConversationForRouter(history, userMessage);
  const lastLine = rendered.slice(rendered.lastIndexOf("\n") + 1);
  return `${candidates.join(",")}\u0000${lastLine}`;
}

function pruneRememberedPreviews(now: number): void {
  for (const [key, entry] of rememberedPreviews) {
    if (now - entry.at > AUTO_PROFILE_PREVIEW_REUSE_MS) {
      rememberedPreviews.delete(key);
    }
  }
  while (rememberedPreviews.size >= MAX_REMEMBERED_PREVIEWS) {
    const oldest = rememberedPreviews.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    rememberedPreviews.delete(oldest);
  }
}

/**
 * Keep a routed preview so the turn that sends the same text reuses it: one
 * Jev call per message instead of two, and the reply's badge matches what
 * the composer showed. Only a routed pick is kept; a fallback is worth
 * retrying at send time.
 */
export function rememberAutoProfilePreview(
  conversationId: string | undefined,
  text: string,
  route: AutoProfileRoute,
  context: string,
  now: number = Date.now(),
): void {
  if (route.outcome !== "routed") {
    return;
  }
  pruneRememberedPreviews(now);
  rememberedPreviews.set(conversationId ?? NO_CONVERSATION_KEY, {
    text: normalizeDraft(text),
    context,
    route,
    at: now,
  });
}

/**
 * The remembered preview for this turn, consumed on read. It has to match
 * the text and the routing context the turn would otherwise send to Jev.
 * A preview made before the conversation existed saw an empty history, so
 * it fits only a turn whose history is still empty: with no history and the
 * same text and candidates, the two requests are identical.
 */
export function takeAutoProfilePreview(args: {
  conversationId: string;
  text: string;
  history: readonly Message[];
  profiles: Readonly<Record<string, ProfileEntry>>;
  now?: number;
}): AutoProfileRoute | undefined {
  const now = args.now ?? Date.now();
  const wanted = normalizeDraft(args.text);
  const candidates = autoProfileCandidates(args.profiles);
  const context = autoProfilePreviewContext(args.history, wanted, candidates);
  const historyIsEmpty =
    recentConversationForRouter(args.history, wanted).length === 0;
  const keys = historyIsEmpty
    ? [args.conversationId, NO_CONVERSATION_KEY]
    : [args.conversationId];
  for (const key of keys) {
    const remembered = rememberedPreviews.get(key);
    if (!remembered) {
      continue;
    }
    if (now - remembered.at > AUTO_PROFILE_PREVIEW_REUSE_MS) {
      rememberedPreviews.delete(key);
      continue;
    }
    if (remembered.text === wanted && remembered.context === context) {
      rememberedPreviews.delete(key);
      return remembered.route;
    }
  }
  return undefined;
}

/** For tests. */
export function clearAutoProfilePreviewsForTesting(): void {
  rememberedPreviews.clear();
}

/**
 * Recent conversational rows for the preview: the same window the turn sees,
 * counted over rows that carry spoken text so tool traffic cannot crowd a
 * short follow-up's context out of the page.
 */
function recentHistoryFromDb(conversationId: string | undefined): Message[] {
  const resolved = conversationId
    ? resolveConversationId(conversationId)
    : null;
  if (!resolved) {
    return [];
  }
  return getMessagesPaginated(
    resolved,
    PREVIEW_HISTORY_ROWS,
    undefined,
    (row) =>
      (row.role === "user" || row.role === "assistant") &&
      plainTextOf(row.content).length > 0,
  ).messages.map((row) => ({
    role: row.role as Message["role"],
    content: row.content,
  }));
}

/**
 * Route a draft the user has not sent yet, so the composer can show the pick
 * as they type. Returns null when the Auto profile is not available on this
 * install; otherwise the same route a turn on the draft would get, remembered
 * for that turn to reuse.
 */
export async function previewAutoProfile(args: {
  conversationId?: string;
  text: string;
  signal?: AbortSignal;
}): Promise<AutoProfileRoute | null> {
  const { llm } = getConfig();
  const profiles = getConversationProfilesForProvider(
    llm.profiles,
    llm.defaultProvider ?? null,
  );
  if (profiles[AUTO_PROFILE_KEY]?.source !== "managed") {
    return null;
  }
  const history = recentHistoryFromDb(args.conversationId);
  const route = await routeAutoProfile({
    conversationId: args.conversationId ?? NO_CONVERSATION_KEY,
    history,
    userMessage: args.text,
    profiles,
    ...(args.signal ? { signal: args.signal } : {}),
  });
  rememberAutoProfilePreview(
    args.conversationId,
    args.text,
    route,
    autoProfilePreviewContext(
      history,
      normalizeDraft(args.text),
      autoProfileCandidates(profiles),
    ),
  );
  return route;
}
