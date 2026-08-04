/**
 * Counts daemon API requests in the fixed window after an app resume.
 *
 * A real iOS feedback bundle showed a burst of daemon requests on every
 * foreground. This counts that burst so the fix has a before/after number
 * instead of an anecdote: one `client_resume.request_count` event per resume,
 * carrying the total and a per-endpoint-group breakdown.
 *
 * Only whole windows are reported. A backgrounding truncates the burst and
 * freezes the WKWebView's timers, so a window that spans a background is a
 * contaminated sample and is dropped rather than emitted.
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

/**
 * Closed label set for the `by_group` breakdown, covering the daemon's
 * high-traffic first segments (`/v1/<segment>` or
 * `/v1/assistants/<id>/<segment>`). Every entry is a real first segment in the
 * generated daemon SDK; `"other"` is the catch-all, so an unlisted or new route
 * is folded into it rather than leaking a path into telemetry.
 */
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
  "integrations",
  "oauth",
  "skills",
  "inference",
  "documents",
  "avatar",
  "home",
  "heartbeat",
  "notifications",
  "lifecycle",
  "settings",
  "disk-pressure",
  "background-tools",
  "subagents",
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

type ResumeWindow = {
  timer: ReturnType<typeof setTimeout>;
  /** Monotonic open time, used to detect a window whose timer was frozen. */
  openedAt: number;
  total: number;
  byGroup: Record<string, number>;
  signal: AppResumeSignal;
};

let resumeWindow: ResumeWindow | null = null;

/** Drops any open window without emitting. */
function cancelOpenWindow(): void {
  if (!resumeWindow) {
    return;
  }
  clearTimeout(resumeWindow.timer);
  resumeWindow = null;
}

function openWindow(signal: AppResumeSignal): void {
  const timer = setTimeout(() => {
    const closed = resumeWindow;
    resumeWindow = null;
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
  resumeWindow = {
    timer,
    openedAt: performance.now(),
    total: 0,
    byGroup: {},
    signal,
  };
}

/**
 * True while a resume window is counting. Callers on the request path check
 * this before doing any work of their own (URL parsing, allowlist lookups), so
 * the steady-state cost of the counter is a single boolean read.
 */
export function isResumeWindowOpen(): boolean {
  return resumeWindow !== null;
}

/** Records one outgoing daemon request. No-op outside a resume window. */
export function noteDaemonApiRequest(url: string): void {
  if (!resumeWindow) {
    return;
  }
  const group = groupForUrl(url);
  resumeWindow.total += 1;
  resumeWindow.byGroup[group] = (resumeWindow.byGroup[group] ?? 0) + 1;
}

/**
 * Opens a counting window on each `app.resume` and drops it on `app.hidden`.
 * Returns an unsubscribe that also drops any window still open, without
 * emitting.
 */
export function subscribeResumeRequestCounter(): () => void {
  const unsubscribeResume = subscribe("app.resume", ({ signal }) => {
    if (resumeWindow) {
      // iOS publishes both a visibility and an app_state resume for a single
      // foreground; the first edge wins so the burst is counted once. A window
      // older than its own span is one whose timer was frozen while the app was
      // backgrounded: its counts belong to an earlier foreground, so drop it
      // and start a fresh window for this resume.
      if (performance.now() - resumeWindow.openedAt < WINDOW_MS) {
        return;
      }
      cancelOpenWindow();
    }
    openWindow(signal);
  });

  // A backgrounding cuts the burst short, so whatever the window has counted so
  // far is a partial sample. Drop it rather than emit a number that reads as a
  // quiet resume.
  const unsubscribeHidden = subscribe("app.hidden", () => {
    cancelOpenWindow();
  });

  return () => {
    unsubscribeResume();
    unsubscribeHidden();
    cancelOpenWindow();
  };
}

export function __resetResumeRequestCounterForTests(): void {
  cancelOpenWindow();
}
