/**
 * Pre-chat onboarding context handoff.
 *
 * Structured context collected by the pre-chat onboarding flow, serialized to
 * JSON and forwarded with the first chat message so the assistant can
 * personalize its opener.
 *
 * Storage choice: `sessionStorage` rather than `localStorage`. The handoff
 * is meant to bridge a single tab navigation (onboarding screen → first
 * chat) and should naturally clear on tab close — a transient, session-scoped
 * value. Using `sessionStorage` also avoids leaking a stale context into
 * another window's chat if the user opens onboarding in two tabs concurrently.
 *
 * Storage-error handling matches the pattern in
 * `@/domains/onboarding/prefs` (e.g. `readSelectedVersion`) and
 * `@/lib/consent/consent-persistence`: every read/write is wrapped in `try/catch` so a
 * disabled or quota-exceeded `sessionStorage` degrades to "no pending
 * context" instead of throwing into the caller.
 */

/** Shape of the pre-chat onboarding payload. Mirrors the Swift model. */
export interface PreChatOnboardingContext {
  /** e.g. ["slack", "linear", "figma"] */
  tools: string[];
  /** e.g. ["code-building", "writing"] */
  tasks: string[];
  /** Personality group ID: "grounded" | "warm" | "energetic" | "poetic" */
  tone: string;
  /** Undefined if the user skipped the name step. */
  userName?: string;
  /** The user's role / occupation, e.g. "Software Engineer". Undefined if not collected. */
  occupation?: string;
  /** Undefined if the user kept the default assistant name. */
  assistantName?: string;
  /** e.g. ["chatgpt", "openclaw", "hermes"] */
  priorAssistants?: string[];
  /**
   * True when the user connected Google during the pre-chat onboarding
   * OAuth screen. Undefined/absent if the screen was not shown or the
   * user skipped.
   */
  googleConnected?: boolean;
  /**
   * OAuth scopes granted by the user when googleConnected is true.
   * Undefined when the user skipped Google connection.
   */
  googleScopes?: string[];
  /** GTM cohort identifier, e.g. "content-automation". */
  cohort?: string;
  /** Auto-send this message on first load instead of waiting for user input. */
  initialMessage?: string;
  /**
   * When true, the auto-sent `initialMessage` is sent hidden: it drives the
   * assistant's first reply but renders no user bubble, so the chat opens as a
   * proactive greeting in the persona the user just configured. Used by the
   * research-onboarding "Let's chat" handoff.
   */
  initialMessageHidden?: boolean;
  /** Bootstrap template filename for the daemon to use. */
  bootstrapTemplate?: string;
  /** Skills to eagerly load. */
  skills?: string[];
  /**
   * Explicit title for the conversation minted on the first message. When set,
   * the daemon persists it as a user-set title (never overwritten by the
   * auto-titler). Used by flows like research onboarding that mint a
   * conversation behind the scenes and don't want an auto-generated title.
   */
  title?: string;
}

export const DEFAULT_PRECHAT_INITIAL_MESSAGE = "Wake up, my friend!";

/**
 * Build the exact user message that ChatPage will auto-send after pre-chat.
 * The pending context is the source of truth for this value; downstream chat
 * code should send it as-is rather than reconstructing it from onboarding
 * fields.
 */
export function buildPreChatInitialMessage(
  ctx: Pick<PreChatOnboardingContext, "assistantName" | "userName">,
): string {
  const assistant = ctx.assistantName?.trim();
  const user = ctx.userName?.trim();
  if (!assistant && !user) return DEFAULT_PRECHAT_INITIAL_MESSAGE;
  const hi = assistant ? `Hi ${assistant}` : "Hi";
  const intro = user ? `, I'm ${user}` : "";
  return `${hi}${intro}. Nice to meet you.`;
}

/**
 * Map of known tool IDs from the PreChat UI to the display names the daemon
 * writes into the persona file. Kept in sync with
 * `vellum-assistant/assistant/src/prompts/normalize-onboarding.ts`.
 */
export const TOOL_DISPLAY_NAMES: Record<string, string> = {
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

/**
 * Map of known task IDs to the plain-language labels the daemon persists.
 * Kept in sync with
 * `vellum-assistant/assistant/src/prompts/normalize-onboarding.ts`.
 */
export const TASK_DISPLAY_LABELS: Record<string, string> = {
  "code-building": "builds code, apps, or tools",
  writing: "writes docs, emails, or content",
  research: "does research and analysis",
  "project-management": "plans and coordinates work",
  scheduling: "handles meetings, calendar, and logistics",
  personal: "handles life admin",
};

export const PRIOR_ASSISTANT_DISPLAY_NAMES: Record<string, string> = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  openclaw: "OpenClaw",
  hermes: "Hermes",
  manus: "Manus",
  gemini: "Gemini",
  copilot: "Copilot",
};

function capitalizeFirst(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function normalizePreChatTools(tools: string[]): string[] {
  return tools.map((id) => TOOL_DISPLAY_NAMES[id] ?? capitalizeFirst(id));
}

export function normalizePreChatTasks(tasks: string[]): string[] {
  return tasks.map((id) => TASK_DISPLAY_LABELS[id] ?? id);
}

export function normalizePreChatPriorAssistants(ids: string[]): string[] {
  return ids.map((id) => PRIOR_ASSISTANT_DISPLAY_NAMES[id] ?? capitalizeFirst(id));
}

/**
 * Convert raw PreChat IDs into the display-ready shape expected by the
 * daemon's onboarding contract. Optional names are preserved as-is so the wire
 * payload keeps the same undefined-vs-empty-string semantics as macOS.
 */
export function normalizePreChatOnboardingContext(
  ctx: PreChatOnboardingContext,
): PreChatOnboardingContext {
  return {
    ...ctx,
    tools: normalizePreChatTools(ctx.tools),
    tasks: normalizePreChatTasks(ctx.tasks),
    priorAssistants: ctx.priorAssistants?.length
      ? normalizePreChatPriorAssistants(ctx.priorAssistants)
      : ctx.priorAssistants,
  };
}

export interface PreChatOnboardingProfileFields {
  preferredName?: string;
  occupation?: string;
  commonWork: string[];
  dailyTools: string[];
}

export function preChatOnboardingProfileFields(
  ctx: PreChatOnboardingContext,
): PreChatOnboardingProfileFields {
  const normalized = normalizePreChatOnboardingContext(ctx);
  return {
    preferredName: normalized.userName?.trim() || undefined,
    occupation: normalized.occupation?.trim() || undefined,
    commonWork: normalized.tasks,
    dailyTools: normalized.tools,
  };
}

/**
 * `sessionStorage` key under which the pending context is stashed. Public
 * so callers/tests can reference the same key without re-declaring it.
 */
export const STORAGE_KEY = "onboarding.prechat.pendingContext";

/**
 * SSR-safe accessor for `sessionStorage`. Reads `globalThis.sessionStorage`
 * directly rather than going through `window`, because in browsers
 * `window === globalThis` (so the storage is the same object) and in
 * tests we can install a shim on `globalThis.sessionStorage` without
 * having to fabricate a `window` global — fabricating `window` in
 * bun-test leaks across test files and breaks heyapi-client URL
 * construction in unrelated suites. Returns `null` when storage is
 * absent (Next.js server render) or when the property getter itself
 * throws (some privacy modes do that).
 */
function getSessionStorage(): Storage | null {
  try {
    const storage = (globalThis as { sessionStorage?: Storage }).sessionStorage;
    return storage ?? null;
  } catch {
    return null;
  }
}

/**
 * Validate that an arbitrary parsed JSON value matches
 * `PreChatOnboardingContext`. We hand-roll this rather than trust the
 * stored JSON because the key is in user-writable storage and a malformed
 * payload should degrade gracefully (return `null`), not propagate as a
 * runtime type error into the chat opener.
 */
function isPreChatOnboardingContext(
  value: unknown,
): value is PreChatOnboardingContext {
  if (value === null || typeof value !== "object") return false;

  // After the object check, use `in` narrowing for required fields and a
  // single record view for optional-field checks (TypeScript doesn't support
  // `in` narrowing on dynamic/optional keys without this step).
  const candidate = value as Record<string, unknown>; // narrowed from `object`

  if (!Array.isArray(candidate.tools)) return false;
  if (!candidate.tools.every((t) => typeof t === "string")) return false;

  if (!Array.isArray(candidate.tasks)) return false;
  if (!candidate.tasks.every((t) => typeof t === "string")) return false;

  if (typeof candidate.tone !== "string") return false;

  if (
    candidate.userName !== undefined &&
    typeof candidate.userName !== "string"
  ) {
    return false;
  }
  if (
    candidate.occupation !== undefined &&
    typeof candidate.occupation !== "string"
  ) {
    return false;
  }
  if (
    candidate.assistantName !== undefined &&
    typeof candidate.assistantName !== "string"
  ) {
    return false;
  }
  if (
    candidate.googleConnected !== undefined &&
    typeof candidate.googleConnected !== "boolean"
  ) {
    return false;
  }
  if (candidate.googleScopes !== undefined) {
    if (!Array.isArray(candidate.googleScopes)) return false;
    if (!candidate.googleScopes.every((s) => typeof s === "string")) return false;
  }
  if (candidate.priorAssistants !== undefined) {
    if (!Array.isArray(candidate.priorAssistants)) return false;
    if (!candidate.priorAssistants.every((s) => typeof s === "string")) return false;
  }
  if (candidate.cohort !== undefined && typeof candidate.cohort !== "string") {
    return false;
  }
  if (candidate.initialMessage !== undefined && typeof candidate.initialMessage !== "string") {
    return false;
  }
  if (
    candidate.initialMessageHidden !== undefined &&
    typeof candidate.initialMessageHidden !== "boolean"
  ) {
    return false;
  }
  if (candidate.bootstrapTemplate !== undefined && typeof candidate.bootstrapTemplate !== "string") {
    return false;
  }
  if (candidate.skills !== undefined) {
    if (!Array.isArray(candidate.skills)) return false;
    if (!candidate.skills.every((s) => typeof s === "string")) return false;
  }
  if (candidate.title !== undefined && typeof candidate.title !== "string") {
    return false;
  }
  return true;
}

/**
 * Persist a pre-chat onboarding context for the next chat surface to
 * consume. Swallows storage errors (disabled storage, quota exceeded,
 * private browsing) so the caller — typically the final onboarding step's
 * "continue" handler — never throws on storage failure. A dropped write
 * just means the chat opener will fall back to its un-personalized
 * default, which is the right degraded behavior.
 */
export function setPendingPreChatContext(
  ctx: PreChatOnboardingContext,
): void {
  const storage = getSessionStorage();
  if (storage === null) return;
  try {
    // Clear any prior value first so a failed `setItem` (quota exceeded,
    // private mode, etc.) leaves storage empty rather than holding the
    // previous context — otherwise `consumePendingPreChatContext()` could
    // replay stale onboarding data after the new write was supposed to
    // overwrite it.
    storage.removeItem(STORAGE_KEY);
    storage.setItem(STORAGE_KEY, JSON.stringify(ctx));
  } catch {
    // Storage unavailable / quota exceeded — degrade silently.
  }
}

/**
 * Read and remove the pending pre-chat onboarding context. Consume-once
 * semantics: after a successful read the key is cleared so a refresh of
 * the chat surface doesn't replay the personalization. Returns `null`
 * when:
 *   - running on the server,
 *   - storage is disabled / inaccessible,
 *   - the key is absent,
 *   - the stored value is malformed JSON, or
 *   - the parsed value doesn't match the expected shape.
 *
 * Idempotent on the empty path: calling it twice without a matching set
 * returns `null` both times.
 */
export function consumePendingPreChatContext(): PreChatOnboardingContext | null {
  const storage = getSessionStorage();
  if (storage === null) return null;

  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;

  // Always clear on read, even if parsing/validation fails below: a
  // malformed payload is unrecoverable, so leaving it in storage just
  // wastes a slot and risks repeated parse failures.
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // Best-effort; continue to attempt parsing the value we already read.
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isPreChatOnboardingContext(parsed)) return null;
  return parsed;
}

/**
 * Drop any pending pre-chat onboarding context without consuming it.
 * Used when the onboarding flow is abandoned (e.g. user navigates back
 * out of the pre-chat steps) so a stale payload from the previous attempt
 * can't leak into a future chat.
 */
export function clearPendingPreChatContext(): void {
  const storage = getSessionStorage();
  if (storage === null) return;
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable — nothing to clear.
  }
}

// ---------------------------------------------------------------------------
// Optimistic assistant-name handoff
//
// The user-chosen assistant name lives in the full PreChatOnboardingContext
// above, but that key is consumed on first send and is gone before the chat
// surface mounts. A separate, lighter key carries just the name so the
// sidebar can show it immediately on first render — no identity-fetch
// round-trip required. The daemon writes IDENTITY.md during the first
// message and the real fetchAssistantIdentity overwrites once it returns.
// ---------------------------------------------------------------------------

/** Storage key for the optimistic assistant-name hint. */
export const ASSISTANT_NAME_KEY = "onboarding.prechat.assistantName";

/**
 * Persist the user-chosen assistant name so the chat sidebar can display
 * it immediately on mount before `fetchAssistantIdentity` resolves.
 * No-op when `name` is blank or storage is unavailable.
 */
export function setPendingAssistantName(name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  const storage = getSessionStorage();
  if (storage === null) return;
  try {
    storage.setItem(ASSISTANT_NAME_KEY, trimmed);
  } catch {
    // Storage unavailable — degrade silently.
  }
}

/**
 * Read and remove the pending assistant-name hint. Consume-once: clears
 * the key on first read so a page refresh doesn't preserve the optimistic
 * value after the real identity has loaded. Returns `null` when absent,
 * storage-disabled, or running server-side.
 */
export function consumePendingAssistantName(): string | null {
  const storage = getSessionStorage();
  if (storage === null) return null;
  try {
    const value = storage.getItem(ASSISTANT_NAME_KEY);
    storage.removeItem(ASSISTANT_NAME_KEY);
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Peek at pre-chat context (non-destructive)
// ---------------------------------------------------------------------------

/**
 * Read the pending pre-chat onboarding context without removing it.
 * Used by ChatPage to check for an `initialMessage` before the context
 * is consumed during the first send.
 */
export function peekPendingPreChatContext(): PreChatOnboardingContext | null {
  const storage = getSessionStorage();
  if (storage === null) return null;

  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isPreChatOnboardingContext(parsed)) return null;
  return parsed;
}
