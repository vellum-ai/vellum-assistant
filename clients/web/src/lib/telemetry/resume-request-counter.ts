/**
 * Counts daemon API requests in the fixed window after an app resume.
 *
 * A real iOS feedback bundle showed a burst of daemon requests on every
 * foreground. This counts that burst so the fix has a before/after number
 * instead of an anecdote: one `client_resume.request_count` event per resume,
 * carrying the total and a per-endpoint-group breakdown.
 *
 * Only whole windows are reported. `app.hidden` is the primary defence: a
 * backgrounding truncates the burst and freezes the host's timers, so the open
 * window is dropped rather than emitted. The `openedAt` staleness checks, one
 * on the resume edge and one in the timer callback, are the fallback for a
 * suspension that fires no hidden edge at all: desktop system sleep with a
 * focused tab, and the WKWebView paths that suspend without a visibility
 * change. Their timers thaw far past the window's span, so the observed age of
 * the window is the only thing left that gives them away. A window either
 * defence discards leaves no sample at all, so the series is a count of clean
 * resumes rather than of every resume. `observed_window_ms` carries the span an
 * emitted window actually covered, so a mildly thawed one that stayed under the
 * guard is filterable downstream instead of riding on the `window_ms` label.
 *
 * {@link installResumeRequestCounter} runs from `lib/api-interceptors.ts`
 * module scope, before React renders, so the counter's `app.resume` handler is
 * registered ahead of every subscriber the React tree adds and the requests
 * those subscribers fire synchronously on resume land inside the window.
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
  byGroup: Partial<Record<EndpointGroup, number>>;
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
    // Fallback for a suspension that fired no `app.hidden`. A frozen timer
    // thaws long past the span it was scheduled for, so its counts cover the
    // whole suspension rather than the `window_ms` they would be labelled
    // with. Discard the contaminated sample instead of emitting it. The
    // threshold is twice the span rather than once because a healthy timer
    // fires at exactly `openedAt + WINDOW_MS`, so a 1x test would discard every
    // healthy window; 2x only catches a genuine freeze.
    const observedWindowMs = performance.now() - closed.openedAt;
    if (observedWindowMs >= WINDOW_MS * 2) {
      return;
    }
    // A zero here is the signal we are looking for once the storm is fixed,
    // so emit regardless of the count.
    emitClientPerfEvent("client_resume.request_count", closed.total, {
      by_group: closed.byGroup,
      window_ms: WINDOW_MS,
      observed_window_ms: Math.round(observedWindowMs),
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

let installed = false;

/**
 * Opens a counting window on each `app.resume` and drops it on `app.hidden`.
 * The latch makes a second call a no-op, so a second evaluation of the
 * importing module (a dev-server module reload, say) cannot leave two handler
 * pairs racing for the one module-level window.
 *
 * Called from `lib/api-interceptors.ts` module scope rather than from a React
 * effect, and the ordering is the whole point. React runs descendant effects
 * before ancestor ones, so a subscriber registered from inside the tree (the
 * timezone sync, the runtime-upgrade banner) would run ahead of a counter
 * registered in `RootLayout`, and the daemon requests it fires synchronously in
 * its own `app.resume` handler would land before the window opened. `main.tsx`
 * imports the interceptor module for its side effects before React renders, so
 * installing there puts this handler first.
 *
 * The subscription lasts for the document. Nothing owns it that could unmount,
 * and it holds no per-consumer state: two bus handlers and one module-level
 * window. That is the same document lifetime the interceptors it installs
 * alongside already have.
 */
export function installResumeRequestCounter(): void {
  if (installed) {
    return;
  }
  installed = true;

  subscribe("app.resume", ({ signal }) => {
    if (resumeWindow) {
      // The bus collapses the visibility + app_state pair for one physical
      // edge at the source (`runtime/event-sources/lifecycle-edge.ts`).
      // First-edge-wins here keeps the burst counted once for the redundant
      // resumes that still reach subscribers: an `online` edge landing next to
      // a foreground one, or a pair spread further apart than that window.
      // A window older than its own span is one whose timer was frozen while
      // the app was suspended: its counts belong to an earlier foreground, so
      // drop it and start a fresh window for this resume.
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
  subscribe("app.hidden", () => {
    cancelOpenWindow();
  });
}

/**
 * Drops the open window and clears the install latch. Pairs with the bus's
 * `__resetForTesting()`, which drops the handlers themselves.
 */
export function __resetResumeRequestCounterForTests(): void {
  cancelOpenWindow();
  installed = false;
}
