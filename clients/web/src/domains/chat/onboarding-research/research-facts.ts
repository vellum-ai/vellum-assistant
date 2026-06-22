/**
 * Research-fact types + streaming-tolerant parsing for the focused-onboarding
 * overlay.
 *
 * SPIKE — research-onboarding flow.
 *
 * The assistant replies with ONLY a JSON array of `{ claim, confidence,
 * sources }` (see the prompt in `@/domains/onboarding/research-prompt.ts`).
 * Because we render claims as they arrive, the parser is incremental: it pulls
 * every *complete* `{...}` object out of the (possibly unterminated) array so a
 * claim surfaces the moment its object closes, mid-stream — no waiting for the
 * full payload.
 *
 * Lives in the chat domain because the overlay that uses it reads chat state.
 */

import type { DisplayMessage } from "@/domains/chat/types/types";

export type ResearchConfidence = "confident" | "maybe" | "guessing";

/** Optional reason a user gives when removing a claim. */
export type RemovalReason = "not_me" | "not_relevant";

export const REMOVAL_REASON_LABELS: Record<RemovalReason, string> = {
  not_me: "Not me",
  not_relevant: "Not relevant",
};

export interface ResearchFact {
  claim: string;
  confidence: ResearchConfidence;
  /** Source URLs the assistant cited as evidence (rendered as proof favicons). */
  sources: string[];
}

/** Flatten a transcript message to its plain text (text blocks, then legacy segments). */
export function extractMessageText(message: DisplayMessage): string {
  const blocks = message.contentBlocks;
  if (blocks && blocks.length > 0) {
    const text = blocks
      .filter(
        (b): b is Extract<typeof b, { type: "text" }> => b.type === "text",
      )
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return (message.textSegments ?? []).join("\n").trim();
}

/** The latest non-user (assistant) message in the transcript, or null. */
export function latestAssistantMessage(
  messages: DisplayMessage[],
): DisplayMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role !== "user") return m;
  }
  return null;
}

/** Bare registrable domain from a URL (www stripped), or null if unparseable. */
export function domainFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function normalizeConfidence(raw: unknown): ResearchConfidence {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (v.startsWith("conf")) return "confident";
  if (v.startsWith("guess")) return "guessing";
  return "maybe";
}

function normalizeSources(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is string => typeof s === "string" && s.trim().length > 0);
}

/** Strip a (possibly unterminated) ```json fence so the body is raw JSON-ish. */
function stripFence(text: string): string {
  const fenceStart = text.search(/```(?:json)?/i);
  if (fenceStart === -1) return text;
  const afterFence = text.slice(fenceStart).replace(/^```(?:json)?/i, "");
  const closeIdx = afterFence.indexOf("```");
  return closeIdx === -1 ? afterFence : afterFence.slice(0, closeIdx);
}

/**
 * Extract every complete top-level `{...}` object from a JSON-array body,
 * tolerating a missing closing `]` and a half-written trailing object. Brace
 * counting is string-aware so braces inside quoted values don't confuse depth.
 */
function extractCompleteObjects(body: string): unknown[] {
  const objects: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
    } else if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          objects.push(JSON.parse(body.slice(start, i + 1)));
        } catch {
          // Shouldn't happen for a balanced slice, but stay defensive.
        }
        start = -1;
      }
    }
  }
  return objects;
}

function toFact(entry: unknown): ResearchFact | null {
  if (!entry || typeof entry !== "object") return null;
  const claim = (entry as { claim?: unknown }).claim;
  if (typeof claim !== "string" || !claim.trim()) return null;
  return {
    claim: claim.trim(),
    confidence: normalizeConfidence((entry as { confidence?: unknown }).confidence),
    sources: normalizeSources((entry as { sources?: unknown }).sources),
  };
}

/**
 * Extract every complete top-level quoted string from an array body, tolerating
 * a missing closing `]` and a half-written trailing string. Used for the flat
 * `suggestions` string array.
 */
function extractCompleteStrings(body: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === "]") break; // end of the array
    if (c === '"') {
      let j = i + 1;
      let escaped = false;
      for (; j < body.length; j++) {
        const d = body[j];
        if (escaped) escaped = false;
        else if (d === "\\") escaped = true;
        else if (d === '"') break;
      }
      if (j >= body.length) break; // incomplete trailing string — stop
      try {
        const value = JSON.parse(body.slice(i, j + 1));
        if (typeof value === "string" && value.trim()) out.push(value);
      } catch {
        // Defensive — a balanced slice should parse.
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return out;
}

/** Body after a `"key": [` opening, or null if that array isn't present yet. */
function arrayScopeFor(body: string, key: string): string | null {
  const k = body.indexOf(`"${key}"`);
  if (k === -1) return null;
  const open = body.indexOf("[", k);
  return open === -1 ? null : body.slice(open + 1);
}

export interface ResearchResult {
  claims: ResearchFact[];
  /** Concrete actions the assistant proposes it could do for the user. */
  suggestions: string[];
}

/**
 * Parse the assistant's `{ claims, suggestions }` object incrementally. Both
 * arrays surface complete elements as they stream (append-only, order-stable —
 * callers can key remove-state by index). Falls back to treating a bare
 * top-level array as `claims` for back-compat.
 */
export function parseResearchResultStreaming(text: string): ResearchResult {
  if (!text) return { claims: [], suggestions: [] };
  const body = stripFence(text);

  const claimsScope = arrayScopeFor(body, "claims");
  const claimsBody =
    claimsScope ??
    (() => {
      const open = body.indexOf("[");
      return open === -1 ? null : body.slice(open + 1);
    })();
  const claims =
    claimsBody === null
      ? []
      : extractCompleteObjects(claimsBody)
          .map(toFact)
          .filter((f): f is ResearchFact => f !== null);

  const suggestionsScope = arrayScopeFor(body, "suggestions");
  const suggestions =
    suggestionsScope === null ? [] : extractCompleteStrings(suggestionsScope);

  return { claims, suggestions };
}

interface ConfidenceBadge {
  label: string;
  tone: "positive" | "warning" | "neutral";
}

/** Map a confidence tier to its card badge label + Tag tone. */
export function confidenceBadge(confidence: ResearchConfidence): ConfidenceBadge {
  switch (confidence) {
    case "confident":
      return { label: "Confident", tone: "positive" };
    case "guessing":
      return { label: "Guessing", tone: "neutral" };
    case "maybe":
    default:
      return { label: "Maybe-ish", tone: "warning" };
  }
}
