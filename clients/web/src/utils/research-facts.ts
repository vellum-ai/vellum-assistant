/**
 * Research-fact types + streaming-tolerant parsing for the research-onboarding
 * flow.
 *
 * SPIKE — research-onboarding flow.
 *
 * The assistant replies with ONLY a JSON object `{ claims, suggestions }` where
 * each claim is `{ claim, confidence, sources }` (see the prompt in
 * `@/domains/onboarding/research-prompt.ts`). Because both the focused-overlay
 * and the in-flow research steps render elements as they arrive, the parser is
 * incremental: it pulls every *complete* `{...}` object (and every complete
 * quoted suggestion string) out of the (possibly unterminated) arrays so an
 * element surfaces the moment it closes, mid-stream — no waiting for the full
 * payload.
 *
 * Lives at top-level `utils/` (not in `domains/chat/` or `domains/onboarding/`)
 * because BOTH domains consume it — the chat-owned focused overlay and the
 * onboarding-owned in-flow steps — and cross-domain imports are import-banned.
 * The chat-domain `research-facts.ts` re-exports everything here (plus its
 * `DisplayMessage`-bound helpers) so existing importers are unaffected.
 */

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

export interface ResearchSuggestion {
  /**
   * The offer as the assistant would speak it — first-person, in the
   * assistant's voice ("I'll build you a training plan…"). This is what the
   * suggestion card renders.
   */
  suggestion: string;
  /**
   * The message actually sent when the user clicks, written from the USER's
   * perspective ("Build me a training plan for my climbing trip"). Keeps the
   * opened conversation reading as the user's own request, not the assistant
   * talking to itself.
   */
  prompt: string;
  /**
   * Optional marketplace plugin (install name, e.g. "marketing-expert") whose
   * skills this suggestion's prompt is designed to trigger. Set by the model
   * when it matches a capability from the injected catalog to the user's
   * situation. The runner background-installs any tagged plugin so its skills
   * are discoverable in the fresh conversation the click opens (plugin-resident
   * skills load per-conversation from disk — no daemon restart needed). Absent
   * for ordinary suggestions.
   */
  plugin?: string;
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

function toSuggestion(entry: unknown): ResearchSuggestion | null {
  if (!entry || typeof entry !== "object") return null;
  const suggestion = (entry as { suggestion?: unknown }).suggestion;
  if (typeof suggestion !== "string" || !suggestion.trim()) return null;
  const rawPrompt = (entry as { prompt?: unknown }).prompt;
  // Fall back to the assistant-voiced text if the model omits the user-voiced
  // prompt — better to send something reasonable than to drop the suggestion.
  const prompt =
    typeof rawPrompt === "string" && rawPrompt.trim()
      ? rawPrompt.trim()
      : suggestion.trim();
  const rawPlugin = (entry as { plugin?: unknown }).plugin;
  const plugin =
    typeof rawPlugin === "string" && rawPlugin.trim()
      ? rawPlugin.trim()
      : undefined;
  return { suggestion: suggestion.trim(), prompt, ...(plugin ? { plugin } : {}) };
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
  /**
   * Concrete actions the assistant proposes it could do for the user. Each is
   * a `{ suggestion, prompt }` pair: the assistant-voiced offer shown on the
   * card and the user-voiced message sent when it's clicked.
   */
  suggestions: ResearchSuggestion[];
  /**
   * True once the reply parses as ONE complete, well-formed JSON object — i.e.
   * the full payload has arrived and was parsed by `JSON.parse` (not the
   * brace-counted streaming fallback). The runner gates settling on this so it
   * never freezes on a partial `suggestions` array (which would render only the
   * first card or two). False while the reply is still streaming or malformed.
   */
  complete: boolean;
}

/** Map a raw array of entries through `mapper`, dropping the ones that don't validate. */
function mapEntries<T>(raw: unknown, mapper: (entry: unknown) => T | null): T[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(mapper).filter((v): v is T => v !== null);
}

/**
 * Strict-parse the first complete top-level `{...}` object out of `body`,
 * tolerating leading/trailing prose. Returns the parsed payload (the object
 * carrying a `claims` and/or `suggestions` array), or null if no complete,
 * well-formed payload is present yet — still streaming, or malformed JSON.
 *
 * This is the load-bearing robustness fix: `JSON.parse` handles string escaping
 * correctly, whereas the brace-counted streaming extractor below mis-tracks an
 * unescaped `"` (or a literal newline) inside a value and silently drops the
 * affected element — and the elements after it — which is how a fully-generated
 * 4-suggestion reply could render as one card.
 */
function parseWholePayload(body: string): Record<string, unknown> | null {
  for (const obj of extractCompleteObjects(body)) {
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      const o = obj as Record<string, unknown>;
      if (Array.isArray(o.claims) || Array.isArray(o.suggestions)) return o;
    }
  }
  return null;
}

/**
 * Parse the assistant's `{ claims, suggestions }` object incrementally. Both
 * arrays surface complete elements as they stream (append-only, order-stable —
 * callers can key remove-state by index). Falls back to treating a bare
 * top-level array as `claims` for back-compat.
 */
export function parseResearchResultStreaming(text: string): ResearchResult {
  if (!text) return { claims: [], suggestions: [], complete: false };
  const body = stripFence(text);

  // Fast path: the whole payload parsed in one shot. Correct (handles escaping)
  // and authoritative once the reply has fully arrived — so it also tells the
  // caller the result is `complete` and safe to settle on.
  const whole = parseWholePayload(body);
  if (whole) {
    return {
      claims: mapEntries(whole.claims, toFact),
      suggestions: mapEntries(whole.suggestions, toSuggestion),
      complete: true,
    };
  }

  // Streaming fallback: pull every *complete* element out of each array so
  // claims/suggestions surface as they land, tolerating the unterminated tail.
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
    suggestionsScope === null
      ? []
      : extractCompleteObjects(suggestionsScope)
          .map(toSuggestion)
          .filter((s): s is ResearchSuggestion => s !== null);

  return { claims, suggestions, complete: false };
}

/**
 * Prettify a marketplace plugin install name into a human display label for the
 * suggestion-card chip — `"marketing-expert"` → `"Marketing Expert"`. Splits on
 * hyphens/underscores/whitespace and title-cases each word. Returns an empty
 * string for a blank/whitespace input so callers can skip rendering the chip.
 */
export function pluginDisplayName(plugin: string): string {
  return plugin
    .split(/[-_\s]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
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
