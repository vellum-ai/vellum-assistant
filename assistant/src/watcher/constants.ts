/** Default poll interval for watchers (60 seconds). */
export const DEFAULT_POLL_INTERVAL_MS = 60_000;
/** Disable watcher after this many consecutive errors. */
export const MAX_CONSECUTIVE_ERRORS = 5;
/**
 * Hard timeout for a single watcher's event-processing background job.
 * Mirrors the order of magnitude used by sibling background producers
 * (filing: 15min, heartbeat: 30min) — chosen to keep a wedged tick from
 * blocking subsequent watchers indefinitely.
 */
export const WATCHER_JOB_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Per-event caps applied before an event is rendered into the `<external_content>`
 * fence the LLM sees.
 *
 * `security/AGENTS.md` requires every untrusted string to be bounded *inside* the
 * fence budget, not just the obvious one: an unbounded field that renders early
 * can otherwise consume the whole budget and truncate away the events after it.
 * Provider payloads have no length ceiling of their own (a Linear comment body or
 * a calendar description is arbitrary-length), so the ceiling is imposed here.
 *
 * These are deliberately generous — Gmail snippets (~200 chars) and Outlook
 * `bodyPreview` (~255) never reach them; they bite only on genuinely long free
 * text, where truncation is preferable to letting one event crowd out the rest.
 */
export const WATCHER_EVENT_SUMMARY_MAX_CHARS = 300;
export const WATCHER_EVENT_PAYLOAD_MAX_CHARS = 4_000;
