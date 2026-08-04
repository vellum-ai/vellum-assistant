/**
 * Counts daemon API requests in the fixed window after an app resume.
 *
 * A real iOS feedback bundle showed a burst of daemon requests on every
 * foreground. This counts that burst so the fix has a before/after number
 * instead of an anecdote: one `client_resume.request_count` event per resume,
 * carrying the total and a per-endpoint-group breakdown.
 *
 * Metadata only. Endpoint labels come from a closed set; raw pathnames and
 * URLs are never stored or emitted.
 *
 * Events in this family carry `page_load_id`, minted per page load by
 * client-perf. Boot telemetry carries its own `boot_id`, and the two ids
 * converge once a caller registers the boot id via `setClientPerfBootId`.
 */

import { subscribe, type AppResumeSignal } from "@/lib/event-bus";
import { emitClientPerfEvent } from "@/lib/telemetry/client-perf";

const WINDOW_MS = 10_000;

const ENDPOINT_GROUPS = [
  "conversations",
  "messages",
  "events",
  "config",
  "feature-flags",
  "identity",
  "schedules",
  "apps",
  "plugins",
  "memory",
  "other",
] as const;

type EndpointGroup = (typeof ENDPOINT_GROUPS)[number];

const KNOWN_GROUPS = new Set<string>(ENDPOINT_GROUPS);

/**
 * Maps a request URL onto the closed label set. Anything unrecognized (and
 * anything unparseable) lands on `"other"` so a new route can never leak a
 * path into telemetry.
 */
function groupForUrl(url: string): EndpointGroup {
  try {
    const segments = new URL(url, "http://localhost").pathname
      .split("/")
      .filter(Boolean);
    const v1 = segments.indexOf("v1");
    if (v1 === -1) {
      return "other";
    }
    // Daemon routes are either `/v1/<resource>` or the assistant-scoped
    // `/v1/assistants/<id>/<resource>`.
    const index = segments[v1 + 1] === "assistants" ? v1 + 3 : v1 + 1;
    const segment = segments[index];
    if (segment && KNOWN_GROUPS.has(segment)) {
      return segment as EndpointGroup;
    }
    return "other";
  } catch {
    return "other";
  }
}

let window_: {
  timer: ReturnType<typeof setTimeout>;
  total: number;
  byGroup: Record<string, number>;
  signal: AppResumeSignal;
} | null = null;

/** Drops any open window without emitting. */
function cancelOpenWindow(): void {
  if (!window_) {
    return;
  }
  clearTimeout(window_.timer);
  window_ = null;
}

/**
 * Records one outgoing daemon request. No-op outside a resume window, so the
 * steady-state cost is a single null check on the request path.
 */
export function noteDaemonApiRequest(url: string): void {
  if (!window_) {
    return;
  }
  const group = groupForUrl(url);
  window_.total += 1;
  window_.byGroup[group] = (window_.byGroup[group] ?? 0) + 1;
}

/**
 * Opens a counting window on each `app.resume`. Returns an unsubscribe that
 * also drops any window still open, without emitting.
 */
export function subscribeResumeRequestCounter(): () => void {
  const unsubscribe = subscribe("app.resume", ({ signal }) => {
    // iOS publishes both a visibility and an app_state resume for a single
    // foreground; first edge wins so the burst is counted once.
    if (window_) {
      return;
    }
    const timer = setTimeout(() => {
      const closed = window_;
      window_ = null;
      if (!closed) {
        return;
      }
      // A zero here is the signal we are looking for once the storm is fixed,
      // so emit regardless of the count.
      emitClientPerfEvent("client_resume.request_count", closed.total, {
        by_group: closed.byGroup,
        window_ms: WINDOW_MS,
        signal: closed.signal,
      });
    }, WINDOW_MS);
    window_ = { timer, total: 0, byGroup: {}, signal };
  });

  return () => {
    unsubscribe();
    cancelOpenWindow();
  };
}

export function __resetResumeRequestCounterForTests(): void {
  cancelOpenWindow();
}
