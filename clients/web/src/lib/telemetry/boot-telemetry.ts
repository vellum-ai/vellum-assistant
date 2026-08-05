/**
 * Boot / resume performance telemetry, the measure-first baseline (LUM-2907).
 *
 * ## Why this rides the `watchdog` wire shape
 *
 * There is no `client_performance` / `page_load` event type on the platform's
 * ingest, and adding one is a cross-repo sequence that must start platform-side
 * (see `assistant/src/telemetry/AGENTS.md`, the emitter is the *last* step; an
 * emitter shipped ahead of its serializer loses every event, because ingest
 * silently skips unknown types and still 2xxes).
 *
 * `watchdog` is already exactly the shape a timing baseline needs, and its
 * serializer says so in as many words: `check_name` is an open string and "the
 * primary group-by dimension downstream", `value` is "the single measured
 * magnitude for the check ... as a FLOAT", and `detail` is an "open JSON bag ...
 * without a platform-coordinated schema change" (bounded at 4096 serialized
 * bytes). So one event per mark, keyed by check name, gives per-mark p50/p95
 * from a plain `GROUP BY` with no JSON parsing and no backend change, the same
 * ride-an-existing-shape move `memory-telemetry.ts` makes on `onboarding`.
 *
 * Destination is live today: `watchdog_raw` (BigQuery) has `check_name STRING`,
 * `value FLOAT`, `detail JSON`, plus `assistant_version`, `organization_id`,
 * and `user_id`, and `stg_telemetry__watchdog` stages it partitioned by day.
 *
 * ## The two families
 *
 * `client_boot.*` is a **cold start** by construction: this module only
 * initializes when a document loads, which on iOS means the shell navigated
 * `WKWebView` at the origin (`clients/ios/README.md`, the app bundles no web
 * assets), so Navigation Timing describes a real page load.
 *
 * `client_resume.*` is a **warm start** by construction: the document survived,
 * the app was merely backgrounded, and the bus published `app.resume`. The two
 * families never overlap, so cold-vs-warm needs no discriminator field, the
 * check-name prefix is the discriminator.
 *
 * ## Relationship to `client-perf.ts`
 *
 * `client-perf.ts` (#40106) is the shared emitter for the sibling measure-first
 * families: `client_switch.*`, `client_resume.request_count`, and
 * `client_list.drain`. It rides the same `watchdog` shape and the same detail-bag
 * convention (raw JSON scalars, `null` for unavailable, no ids or raw pathnames),
 * and this module follows that convention so the families stay queryable
 * together. `startBootTelemetry` registers its `boot_id` through
 * `setClientPerfBootId`, which is the join: every sibling event from the same
 * page load then carries the boot it happened in, so a slow switch or list drain
 * can be traced back to its boot waterfall.
 *
 * This module keeps its own envelope construction rather than calling
 * `emitClientPerfEvent` per mark, for two reasons: a boot flushes ~10 marks as
 * ONE batched POST (per-mark emits would mean ten requests on the boot path),
 * and `emitClientPerfEvent` rounds `value` to an integer, which would destroy
 * the CLS score (see `SCORE_MARKS`). Folding the two together needs a shared
 * envelope builder with a unit-aware rounding hook; tracked in LUM-3060.
 *
 * Note that `client_resume.*` is a shared prefix: `to_sse_open` is emitted here,
 * `request_count` by `resume-request-counter.ts`. Both describe the same warm
 * start, so keep new resume check names consistent across the two.
 *
 * ## Privacy
 *
 * Metadata only. No message content, no conversation/assistant ids, no URLs:
 * `route` is a fixed label from a closed set (see `bootRouteLabel`), never a
 * pathname, so a conversation id can't ride in on it. `boot_id` is a fresh
 * random UUID per page load used only to stitch one waterfall back together.
 *
 * ## Reading the paint marks
 *
 * `fcp` and `lcp` are only comparable across visible page loads. A document
 * that loads while hidden has its paint deferred until it is shown, so those
 * two marks describe "time until the user looked at it", not render cost. Both
 * are therefore floors, not costs, and a long tail on them is the first thing
 * to segment out before concluding anything about render work.
 */

import { subscribe } from "@/lib/event-bus";
import { readAnalyticsConsent } from "@/lib/telemetry/consent";
import { setClientPerfBootId } from "@/lib/telemetry/client-perf";
import { postTelemetryEvents } from "@/lib/telemetry/ingest";
import { detectClientOs, isNativeMobile } from "@/runtime/platform-detection";

/**
 * Marks in the cold-boot waterfall, in the order they are expected to land.
 *
 * The first six are read from browser timing APIs and need no call sites; the
 * rest are stamped by `markBoot()` at the gate they name.
 */
export type BootMark =
  /** `PerformanceNavigationTiming.responseStart`, time to first byte. */
  | "ttfb"
  /** `domContentLoadedEventEnd`. */
  | "dom_content_loaded"
  /** `loadEventEnd`. */
  | "load_event_end"
  /** First Contentful Paint. */
  | "fcp"
  /** Largest Contentful Paint. Absent on WebKit before Safari 26.2. */
  | "lcp"
  /**
   * Cumulative Layout Shift. NOTE: the emitted `value` is the CLS *score*, not
   * milliseconds, the one mark in this family that isn't a duration. Chromium
   * only; WebKit has never shipped `layout-shift`.
   */
  | "cls"
  /** `boot()` finished `await initSafeAreaBridge()`, first render's gate. */
  | "safe_area_ready"
  /** `boot()` finished the lockfile read + `initSession()`. */
  | "session_ready"
  /** `boot()` is about to call `createRoot().render()`. */
  | "react_mount"
  /**
   * `authMiddleware` reached `next()`, every consent / assistants-list /
   * platform-probe wait it serializes has resolved or timed out.
   */
  | "route_guard_settled"
  /** First `sse.opened` on this page load. */
  | "sse_open"
  /** The transcript stopped rendering its skeleton, first meaningful paint. */
  | "transcript_painted"
  /** `ActiveChatView` mounted: chat is interactive. Terminal (success). */
  | "chat_interactive"
  /** Chat settled on a non-interactive screen instead. Terminal (failure). */
  | "chat_blocked";

/** Marks that end the boot waterfall and trigger the flush. */
const TERMINAL_MARKS = new Set<BootMark>(["chat_interactive", "chat_blocked"]);

/**
 * Marks whose `value` is NOT a duration. Only `cls`, which is a unitless
 * layout-shift score in roughly the 0 to 0.5 range.
 *
 * This set exists because rounding a score to the nearest integer destroys it:
 * a perfectly normal CLS of 0.05 becomes 0, and the whole series reads as
 * "no layout shift anywhere". Durations round to whole milliseconds; scores keep
 * three decimals. The `unit` field in the detail bag carries the same
 * distinction downstream, so nobody averages milliseconds together with a score.
 */
const SCORE_MARKS = new Set<BootMark>(["cls"]);

function markUnit(mark: BootMark): "ms" | "score" {
  return SCORE_MARKS.has(mark) ? "score" : "ms";
}

function roundForUnit(mark: BootMark, value: number): number {
  return SCORE_MARKS.has(mark)
    ? Math.round(value * 1000) / 1000
    : Math.round(value);
}

const BOOT_CHECK_PREFIX = "client_boot";
const RESUME_CHECK_PREFIX = "client_resume";

/**
 * Backstop flush for a boot that never reaches a terminal mark at all: a
 * wedged lifecycle probe, or a user who lands somewhere outside chat. Without
 * it those boots contribute nothing, which is exactly the population most worth
 * seeing. Comfortably past the two serialized 5s waits in `auth-middleware.ts`
 * so a slow-but-successful boot still flushes as one complete waterfall.
 */
const BOOT_FLUSH_DEADLINE_MS = 20_000;

/**
 * Grace period between a terminal mark and the flush, so the paint vitals that
 * are still settling get into the same batch. See `scheduleTerminalFlush`.
 */
export const TERMINAL_FLUSH_GRACE_MS = 3_000;

/**
 * How long a pending resume measurement stays open before it is abandoned.
 *
 * Abandoned, not reported: "no reopen was observed" is NOT evidence of a
 * stalled resume. `sse-service.ts` deliberately does not reopen (and so does
 * not publish `sse.opened`) when the socket was never torn down, which covers
 * two of the most common resumes there are: a short hide that comes back inside
 * the hidden-teardown grace window, and an `online` resume that fires while the
 * stream is still live. Emitting a failure event on the silence would fill the
 * denominator with healthy resumes and make the resume baseline read worse the
 * better the app behaves. Distinguishing the two needs a signal only
 * `sse-service` can give (it is the thing that knows whether a reopen was
 * required); until it does, this family measures observed reopens only. Tracked
 * in LUM-3050.
 */
const RESUME_PENDING_TTL_MS = 10_000;

/** Which shell this page load is running in. */
type BootSurface = "ios_native" | "android_native" | "web";

interface BootContext {
  boot_id: string;
  surface: BootSurface;
  os: string;
  /** `PerformanceNavigationTiming.type`, `navigate` / `reload` / `back_forward`. Null when unavailable. */
  nav_type: string | null;
  route: string;
  /** Whether this engine can report `lcp` at all, see the `lcp` mark. */
  lcp_supported: boolean;
  /** Whether this engine can report `cls` at all, see the `cls` mark. */
  cls_supported: boolean;
}

/**
 * Route labels, as a closed set. A pathname is never emitted: the conversation
 * route carries an id, and `/assistant` (the new-conversation draft) vs
 * `/assistant/conversations/:id` is the distinction the baseline is actually
 * asking about, so a fixed label answers it without shipping the id.
 */
export function bootRouteLabel(pathname: string): string {
  if (pathname === "/assistant" || pathname === "/assistant/") {
    return "new_conversation";
  }
  if (pathname.startsWith("/assistant/conversations/")) {
    return pathname.endsWith("/inspect")
      ? "conversation_inspect"
      : "conversation";
  }
  if (pathname.startsWith("/assistant/settings")) {
    return "settings";
  }
  if (pathname.startsWith("/account")) {
    return "account";
  }
  if (pathname.startsWith("/assistant/onboarding")) {
    return "onboarding";
  }
  return "other";
}

function detectSurface(): BootSurface {
  const os = detectClientOs();
  if (!isNativeMobile()) {
    return "web";
  }
  return os === "android" ? "android_native" : "ios_native";
}

function supportsEntryType(entryType: string): boolean {
  const supported = PerformanceObserver.supportedEntryTypes;
  return Array.isArray(supported) && supported.includes(entryType);
}

/**
 * Why a mark ended the boot without chat becoming interactive. Closed set, so
 * no free-form string can reach the wire through it.
 *
 * Only genuinely stuck states belong here. A state the app recovers from on its
 * own is NOT a blocked boot: first-run setup (`initializing`), teardown
 * (`cleaning_up`), and a transient transport error that the lifecycle service
 * auto-retries all resolve into chat by themselves, and reporting them as
 * terminal would count the same first-run boot as both a failure and a success.
 * Those states leave the boot unsettled instead, and the deadline backstop
 * reports the waterfall with `flush_trigger: "deadline"` if they never clear.
 */
export type BootBlockedReason =
  /** `useStuckConnecting` escalated: auth init or the lifecycle probe wedged. */
  | "stuck_connecting"
  /** The assistant lifecycle reported a non-transient error state. */
  | "lifecycle_error"
  /** Self-hosted assistant unreachable or gated off. */
  | "self_hosted_unavailable";

/**
 * What ended the boot record. Rides every event so a truncated waterfall is
 * readable as truncated rather than as a boot that never got there.
 *
 * `terminal` is the clean case. `pagehide` means the page went away mid-boot,
 * so later marks are missing because the boot was cut short. `deadline` means
 * the boot never settled at all within `BOOT_FLUSH_DEADLINE_MS`.
 */
export type BootFlushTrigger = "terminal" | "pagehide" | "deadline";

interface RecordedMark {
  value: number;
  /** Merged into this one mark's detail bag. */
  extra?: Record<string, string>;
}

/** Marks recorded so far, in insertion order. `value` is ms (except `cls`). */
const marks = new Map<BootMark, RecordedMark>();

let context: BootContext | null = null;
let flushed = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** Set once any terminal mark lands, so a second one cannot also be recorded. */
let terminalRecorded = false;
/**
 * Whether the page was ever hidden before the boot settled.
 *
 * A boot that was backgrounded mid-flight is a contaminated sample: its
 * wall-clock spans include background time, and its paint marks are deferred
 * until the page is shown again. On iOS that is the routine launch-then-switch-
 * away pattern, so these have to be identifiable and excluded rather than left
 * to drag the p95 out. Reported, not dropped, because the *rate* of it is
 * itself worth seeing.
 */
let backgroundedBeforeTerminal = false;

const NOOP_TEARDOWN = (): void => {};

// Detach handles for the document-lifetime registrations. Held only so the test
// seam can undo them between cases; `startBootTelemetry` hands its caller a
// no-op (see its docstring).
let detachTiming: () => void = NOOP_TEARDOWN;
let detachResume: () => void = NOOP_TEARDOWN;
let detachPageHide: (() => void) | null = null;

/**
 * Records a boot mark at the current time.
 *
 * First write wins: every mark in this family is a *first* occurrence (first
 * paint, first SSE open, first interactive), and re-navigating within the same
 * page load must not overwrite the cold-boot number with a warm one.
 *
 * Safe to call before `startBootTelemetry()`, marks buffer until flush.
 */
export function markBoot(
  mark: BootMark,
  options: { value?: number; extra?: Record<string, string> } = {},
): void {
  if (flushed || marks.has(mark)) {
    return;
  }
  // Terminal exclusivity: a boot has exactly one outcome. Without this a
  // lifecycle that passes through a non-interactive screen on its way to chat
  // would record both `chat_blocked` and `chat_interactive`, and every such
  // boot would be counted once in the numerator and once in the denominator of
  // the same success rate. The call sites are careful not to report transient
  // states as terminal (see `chat-page.tsx`); this is the structural backstop
  // that makes a mistake there impossible to express.
  if (TERMINAL_MARKS.has(mark)) {
    if (terminalRecorded) {
      return;
    }
    terminalRecorded = true;
  }
  marks.set(mark, {
    value: options.value ?? performance.now(),
    extra: options.extra,
  });
  // A terminal mark arms the flush, and so does `transcript_painted`, because
  // either can be the last of the pair to land. `scheduleTerminalFlush` is the
  // one place that decides whether the boot is actually settled.
  if (TERMINAL_MARKS.has(mark) || mark === "transcript_painted") {
    if (terminalRecorded) {
      scheduleTerminalFlush();
    }
  }
}

/**
 * Arms the post-terminal flush.
 *
 * Reaching interactive does NOT mean the vitals have landed. Verified in a real
 * Chromium page load: a document that loads while hidden defers
 * `first-contentful-paint` until it is shown (2396ms in the harness, long after
 * a terminal mark would have fired), and LCP is by definition not final until
 * the largest element stops changing. Flushing synchronously on the terminal
 * mark therefore ships a waterfall with the paint marks missing, which reads
 * downstream as "this engine can't report them" rather than "we sent too early".
 *
 * So the terminal mark starts a short grace window instead. `pagehide` still
 * flushes immediately, and the boot deadline is still the outer backstop, so the
 * grace period can only delay a send, never lose one.
 */
function scheduleTerminalFlush(): void {
  if (flushed) {
    return;
  }
  // Never shorten the deadline while a mark we are still expecting is
  // outstanding. `chat_interactive` fires when the assistant goes active, which
  // is BEFORE the transcript's initial history fetch resolves; on a slow fetch
  // the 3s window would close the boot without `transcript_painted`, and it
  // would do so precisely on the slowest loads. That is the exact population
  // this baseline exists to measure, so the bias would run backwards. Leave the
  // 20s deadline armed instead and let `transcript_painted` open the grace
  // window when it lands (a boot where it never lands flushes on the deadline,
  // tagged as such, which is the honest reading).
  if (!marks.has("transcript_painted")) {
    return;
  }
  // Replaces whichever timer is already armed (the outer boot deadline, or an
  // earlier grace window). Exactly one timer exists at a time, and the marks
  // that arm this can each only fire once, so it cannot be re-armed forever.
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
  }
  flushTimer = setTimeout(flushBootTelemetry, TERMINAL_FLUSH_GRACE_MS);
}

/**
 * Records the terminal failure mark with its reason.
 *
 * Separate from `markBoot` so the reason is pinned to the closed
 * `BootBlockedReason` union at every call site rather than typed as an open
 * string bag.
 */
export function markBootBlocked(reason: BootBlockedReason): void {
  markBoot("chat_blocked", { extra: { reason } });
}

/**
 * Builds one `watchdog` event per recorded mark.
 *
 * Split into its own export so the shape is testable without a live transport
 * and without the module's flush latch.
 */
export function buildBootEvents(
  recorded: ReadonlyMap<BootMark, RecordedMark>,
  ctx: BootContext,
  flushTrigger: BootFlushTrigger,
): object[] {
  return [...recorded].map(([mark, { value, extra }]) => ({
    type: "watchdog" as const,
    daemon_event_id: crypto.randomUUID(),
    recorded_at: Date.now(),
    check_name: `${BOOT_CHECK_PREFIX}.${mark}`,
    // Durations round to whole milliseconds (sub-millisecond precision is noise
    // at this scale, and the raw floats are a small fingerprinting surface);
    // scores keep their decimals. See `SCORE_MARKS`.
    value: roundForUnit(mark, value),
    detail: {
      ...ctx,
      unit: markUnit(mark),
      flush_trigger: flushTrigger,
      backgrounded_before_terminal: backgroundedBeforeTerminal,
      ...extra,
    },
  }));
}

/**
 * Sends whatever marks have landed and latches the family closed.
 *
 * Consent is checked **here**, immediately before the request, rather than at
 * `markBoot()` time. The reason is privacy, not loss: an opt-out that lands
 * during the boot window must still suppress the upload, and only a check at
 * send time sees it. Recording a mark is not an upload, so buffering first
 * costs nothing.
 *
 * To be precise about the race, since it is easy to overstate: an unhydrated
 * consent state does NOT read as opted out. `readAnalyticsConsent()` resolves
 * an unknown `serverAnalyticsEffective` to `true` (analytics is opt-out, so
 * never-asked authorizes), and a persisted opt-out is read synchronously from
 * localStorage at store creation. So a record-time gate would not have dropped
 * boots that outran their consent sync. It would only have missed the opt-out
 * arriving mid-window, which is the case that actually matters.
 *
 * Same contract as the resume family, which posts each event as its interval
 * closes and so reads consent there: both check immediately before the request.
 */
export function flushBootTelemetry(
  trigger: BootFlushTrigger = "terminal",
): void {
  if (flushed || !context || marks.size === 0) {
    return;
  }
  // Re-read Navigation Timing before latching. The startup read happens from a
  // React effect, which routinely runs BEFORE the document's `load` event, and
  // at that point `domContentLoadedEventEnd` / `loadEventEnd` are still 0.
  // Verified in a real page load: 0 and 0 at startup, 79ms and 81ms once the
  // document finished. Without this re-read the two marks the ticket explicitly
  // asks for would be silently absent from every boot.
  readNavigationTiming();
  flushed = true;
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!readAnalyticsConsent()) {
    return;
  }
  postTelemetryEvents(buildBootEvents(marks, context, trigger));
}

/**
 * Copies whatever Navigation Timing can report right now into the mark buffer.
 * Called at startup and again at flush; `markBoot` is first-write-wins, so the
 * earliest non-zero reading is the one that ships.
 */
function readNavigationTiming(): void {
  const [nav] = performance.getEntriesByType(
    "navigation",
  ) as PerformanceNavigationTiming[];
  if (!nav) {
    return;
  }
  // A zero here means "not measurable yet" (the event has not fired) or "not
  // exposed" (a cross-origin response without Timing-Allow-Origin), never
  // "instant", so zeros are skipped rather than recorded as a real 0ms.
  if (nav.responseStart > 0) {
    markBoot("ttfb", { value: nav.responseStart });
  }
  if (nav.domContentLoadedEventEnd > 0) {
    markBoot("dom_content_loaded", { value: nav.domContentLoadedEventEnd });
  }
  if (nav.loadEventEnd > 0) {
    markBoot("load_event_end", { value: nav.loadEventEnd });
  }
}

/**
 * Reads the marks the browser already recorded for us, and observes the ones
 * that land later.
 *
 * Every entry type is feature-detected rather than assumed. That is load-bearing
 * on the surface this ticket is about: WebKit only shipped
 * `largest-contentful-paint` in Safari 26.2, and has never shipped
 * `layout-shift`, so on iOS `lcp` is version-dependent and `cls` is simply
 * absent. `lcp_supported` / `cls_supported` ride the detail bag so a missing
 * mark reads as "this engine can't report it" rather than "the page never got
 * there".
 */
function collectNavigationTiming(): () => void {
  readNavigationTiming();

  const observers: PerformanceObserver[] = [];
  const observeType = (
    entryType: string,
    handler: (entries: PerformanceEntryList) => void,
  ): void => {
    if (!supportsEntryType(entryType)) {
      return;
    }
    const observer = new PerformanceObserver((list) =>
      handler(list.getEntries()),
    );
    // `buffered` replays entries that fired before this module ran, without it
    // FCP is routinely missed, since paint beats the bundle's own execution.
    observer.observe({ type: entryType, buffered: true });
    observers.push(observer);
  };

  observeType("paint", (entries) => {
    for (const entry of entries) {
      if (entry.name === "first-contentful-paint") {
        markBoot("fcp", { value: entry.startTime });
      }
    }
  });

  // LCP is re-reported as the largest element changes; the last value before
  // the flush is the real one, so this overwrites rather than first-wins.
  observeType("largest-contentful-paint", (entries) => {
    const last = entries.at(-1);
    if (last && !flushed) {
      marks.set("lcp", { value: last.startTime });
    }
  });

  // CLS accumulates: sum the shifts that weren't tied to a recent input.
  let cls = 0;
  observeType("layout-shift", (entries) => {
    for (const entry of entries as (PerformanceEntry & {
      value?: number;
      hadRecentInput?: boolean;
    })[]) {
      if (!entry.hadRecentInput && typeof entry.value === "number") {
        cls += entry.value;
      }
    }
    if (!flushed) {
      marks.set("cls", { value: cls });
    }
  });

  return () => {
    for (const observer of observers) {
      observer.disconnect();
    }
  };
}

/**
 * Records how long a warm start took to come back to life.
 *
 * The boundary is `app.resume` → the next `sse.opened`: the app is "back" when
 * its live channel is, and both edges already exist on the bus, so this needs no
 * new plumbing in `sse-service.ts`. A resume that never sees a reopen is
 * abandoned rather than reported, because silence is not evidence of a stall;
 * see `RESUME_PENDING_TTL_MS`. That leaves the family without a failure
 * denominator, so its p50/p95 describes observed reopens only and is not a
 * success rate. Tracked in LUM-3050.
 *
 * Consent is read at send time, which for this family is emit time, because
 * each event is posted the moment its interval closes. The boot family buffers
 * marks and so reads consent at flush; both check immediately before the
 * request, which is the contract that matters.
 */
function subscribeResumeTelemetry(): () => void {
  let pendingAt: number | null = null;
  let pendingSignal: string | null = null;
  let pendingAwayMs: number | null = null;
  let hiddenAt: number | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  const emit = (mark: string, value: number, extra: object): void => {
    if (!context || !readAnalyticsConsent()) {
      return;
    }
    postTelemetryEvents([
      {
        type: "watchdog",
        daemon_event_id: crypto.randomUUID(),
        recorded_at: Date.now(),
        check_name: `${RESUME_CHECK_PREFIX}.${mark}`,
        value: Math.round(value),
        detail: {
          boot_id: context.boot_id,
          surface: context.surface,
          os: context.os,
          ...extra,
        },
      },
    ]);
  };

  const clearPending = (): void => {
    pendingAt = null;
    pendingSignal = null;
    pendingAwayMs = null;
    // `hiddenAt` is cleared with the rest, so `away_ms` is null on a resume that
    // no background preceded. `app.resume` is published with signal `"online"`
    // whenever the network comes back, with no `app.hidden` before it; leaving
    // the last hide in place made that report the hours since some earlier
    // background as time spent away.
    hiddenAt = null;
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
  };

  const unsubHidden = subscribe("app.hidden", () => {
    hiddenAt = performance.now();
    // A hide before the boot settles contaminates that boot's spans (they now
    // include background time) and defers its paint marks, so the cold-boot
    // record carries the fact. See `backgroundedBeforeTerminal`.
    if (!terminalRecorded) {
      backgroundedBeforeTerminal = true;
    }
  });

  const unsubResume = subscribe("app.resume", ({ signal }) => {
    // A resume burst (iOS publishes `visibility` and `app_state` in close
    // succession, the bus explicitly leaves that dedup to consumers) must
    // measure one interval, not two. The first edge wins; the rest are noise.
    if (pendingAt !== null) {
      return;
    }
    pendingAt = performance.now();
    pendingSignal = signal;
    // Away-time is computed and consumed HERE, at the moment the interval
    // opens, not when it closes. A pending measurement can outlive a second
    // hide: the user foregrounds, the socket has not reopened yet, and they
    // background again before it does. Reading `hiddenAt` at emit time would
    // then subtract the LATER hide from the EARLIER resume and report a
    // negative `away_ms`. Snapshotting makes the in-flight measurement immune
    // to anything that happens to `hiddenAt` afterwards.
    pendingAwayMs = hiddenAt === null ? null : Math.round(pendingAt - hiddenAt);
    hiddenAt = null;
    // Abandon the measurement rather than reporting a failure. See
    // `RESUME_PENDING_TTL_MS`: silence here means "no reopen was needed", not
    // that the resume failed, and the bus cannot tell the two apart.
    pendingTimer = setTimeout(clearPending, RESUME_PENDING_TTL_MS);
  });

  const unsubOpened = subscribe("sse.opened", () => {
    if (pendingAt === null) {
      // A cold boot's first open is the `client_boot.sse_open` mark, not a
      // resume; only opens with a resume outstanding belong to this family.
      markBoot("sse_open");
      return;
    }
    emit("to_sse_open", performance.now() - pendingAt, {
      signal: pendingSignal,
      away_ms: pendingAwayMs,
    });
    clearPending();
  });

  return () => {
    clearPending();
    unsubHidden();
    unsubResume();
    unsubOpened();
  };
}

/**
 * Starts collection for this page load. Idempotent.
 *
 * Wired from `use-event-bus-init.ts` alongside `subscribeLifecycleDiagnostics()`
 *, the same "bus consumer attached once at mount" slot, and early enough that
 * the subscription is registered before the effect that attaches the SSE
 * service.
 *
 * ## Why the returned teardown is intentionally a no-op
 *
 * What this module measures is scoped to the DOCUMENT, not to the React tree:
 * every mark is an offset from `performance.timeOrigin`, and there is exactly
 * one boot per page load. Its registrations have to outlive any component,
 * because the `pagehide` flush is the thing that rescues a boot the user walks
 * away from, and a paint observer detached at unmount stops reporting the very
 * vitals that arrive late.
 *
 * Its caller, though, is a React effect under `<StrictMode>`, which runs
 * setup, cleanup, setup in development. A teardown that detached the observers
 * and bus subscriptions but left the `context` latch set would make the second
 * setup a no-op and leave dev builds with no paint marks, no `sse_open`, no
 * resume tracking, and no flush on leave, which is to say local numbers that
 * are nothing like production's. Restoring restartability instead would mean
 * tearing down live observers on every remount and re-arming a second deadline.
 *
 * Detaching is the wrong half of that choice, so this keeps the registration
 * for the document's lifetime and hands back a no-op. Contrast
 * `subscribeLifecycleDiagnostics()` in the same array, whose recorder genuinely
 * is component-scoped. Tests reset through `__resetBootTelemetryForTests`.
 */
export function startBootTelemetry(): () => void {
  if (typeof window === "undefined" || context) {
    return NOOP_TEARDOWN;
  }

  context = {
    boot_id: crypto.randomUUID(),
    surface: detectSurface(),
    os: detectClientOs(),
    // Null, not a `"unknown"` sentinel: `client-perf.ts` documents the shared
    // detail-bag convention for the `client_*` families, and a string sentinel
    // forces a cast before any aggregation.
    nav_type:
      (
        performance.getEntriesByType("navigation")[0] as
          | PerformanceNavigationTiming
          | undefined
      )?.type ?? null,
    route: bootRouteLabel(window.location.pathname),
    lcp_supported: supportsEntryType("largest-contentful-paint"),
    cls_supported: supportsEntryType("layout-shift"),
  };

  // Join the two measure-first families. `client-perf.ts` (#40106) stamps
  // `boot_id` onto every `client_switch.*` / `client_resume.request_count` /
  // `client_list.drain` event once a caller registers one, and this is the boot
  // series it was waiting for: nothing else calls it, and
  // `resume-request-counter.ts` names the registration as the thing that makes
  // the families converge. With it, a slow switch or list drain can be traced
  // back to the boot it happened in.
  setClientPerfBootId(context.boot_id);

  // Detach handles are kept for `__resetBootTelemetryForTests`, not for the
  // caller: see the no-op teardown note above.
  detachTiming = collectNavigationTiming();
  detachResume = subscribeResumeTelemetry();

  flushTimer = setTimeout(
    () => flushBootTelemetry("deadline"),
    BOOT_FLUSH_DEADLINE_MS,
  );

  // A boot that is backgrounded or navigated away mid-flight still reports what
  // it reached, tagged `pagehide` so downstream can tell a cut-short waterfall
  // from one that genuinely stalled. `postTelemetryEvents` already sends with
  // `keepalive`, so the request outlives the page.
  detachPageHide = (): void => flushBootTelemetry("pagehide");
  window.addEventListener("pagehide", detachPageHide);

  // A document that was already hidden when boot telemetry started (an iOS
  // prewarm, or a page opened in a background tab) is contaminated from the
  // outset. This is a one-time state read, not a listener: ongoing hides arrive
  // through the bus's `app.hidden` in `subscribeResumeTelemetry`, because
  // `runtime/event-sources/dom-visibility.ts` owns the app's only
  // `visibilitychange` registration (EVENT_BUS.md).
  if (document.visibilityState === "hidden") {
    backgroundedBeforeTerminal = true;
  }

  return NOOP_TEARDOWN;
}

/** Test seam, detaches everything and clears the module-local latches. */
export function __resetBootTelemetryForTests(): void {
  detachTiming();
  detachResume();
  if (detachPageHide && typeof window !== "undefined") {
    window.removeEventListener("pagehide", detachPageHide);
  }
  detachTiming = NOOP_TEARDOWN;
  detachResume = NOOP_TEARDOWN;
  detachPageHide = null;
  marks.clear();
  context = null;
  flushed = false;
  terminalRecorded = false;
  backgroundedBeforeTerminal = false;
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}
