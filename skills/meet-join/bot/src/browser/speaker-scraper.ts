/**
 * DOM active-speaker scraper.
 *
 * Watches Google Meet's participant-tile grid for changes to the
 * active-speaker indicator ({@link INGAME_ACTIVE_SPEAKER_INDICATOR}) and
 * emits a {@link SpeakerChangeEvent} every time the active speaker
 * transitions to a new participant.
 *
 * ## Strategy
 *
 * Meet toggles `data-active-speaker="true"` on exactly one participant tile
 * at a time. Rather than poll from the Node side (which would require a
 * Playwright round-trip every {@link ScraperOptions.pollMs}ms), we install
 * a `MutationObserver` *inside the page* that fires whenever the
 * active-speaker attribute changes on any tile. The observer invokes a
 * Node-side callback (registered via {@link Page.exposeFunction}) with the
 * new speaker's ID/name.
 *
 * Because `exposeFunction` setup is occasionally fragile (e.g. if the page
 * is mid-navigation when we install), the scraper also falls back to
 * straight polling of {@link INGAME_ACTIVE_SPEAKER_INDICATOR} every
 * {@link ScraperOptions.pollMs}ms. Both paths converge on the same dedupe
 * logic — a repeat activation of the same speaker produces no event.
 *
 * ## Contract
 *
 * - Only emits events on transitions. A static fixture (no active-speaker
 *   changes) must produce zero events, no matter how long we observe.
 * - Emits `SpeakerChangeEvent` with `timestamp` as an ISO-8601 string so
 *   the payload validates against `SpeakerChangeEventSchema`.
 * - `stop()` is idempotent and must not throw; subsequent invocations are
 *   no-ops.
 */

import type { Page } from "playwright";
import type { SpeakerChangeEvent } from "../../../contracts/index.js";

import { INGAME_ACTIVE_SPEAKER_INDICATOR } from "./dom-selectors.js";

/**
 * Narrow slice of the Playwright `Page` surface the scraper actually uses.
 * Accepting this interface (instead of the full `Page`) keeps unit tests
 * mockable without pulling in a real browser.
 */
export type ScraperPage = Pick<
  Page,
  "evaluate" | "exposeFunction" | "isClosed"
>;

/**
 * Payload the in-page observer sends out to the Node-side callback. Kept
 * deliberately small and primitive so it serializes cleanly across the
 * Playwright bridge.
 */
export interface SpeakerTileSnapshot {
  speakerId: string;
  speakerName: string;
}

export interface ScraperOptions {
  /** Meeting ID stamped onto every emitted event. */
  meetingId: string;

  /**
   * Poll cadence, in ms. Drives both the polling fallback and the interval
   * at which the MutationObserver's in-page queue is drained. Defaults to
   * 150ms — fast enough that a normal conversational turn doesn't slip
   * between polls, slow enough to keep wakeups cheap.
   */
  pollMs?: number;
}

export interface SpeakerScraperHandle {
  /**
   * Stop the scraper. Tears down the in-page observer + polling loop and
   * detaches the exposed callback. Idempotent — calling twice is safe.
   */
  stop: () => void;
}

/** Default poll cadence. Exported so tests and callers can reference it. */
export const DEFAULT_POLL_MS = 150;

/**
 * Monotonically-increasing suffix so multiple concurrent scrapers on the
 * same page each get a unique `window.__meetBotSpeakerChange_<n>__` handle.
 * Playwright's `exposeFunction` rejects duplicate names.
 */
let exposeCounter = 0;

/**
 * Begin observing active-speaker transitions on `page` and invoke
 * `onChange` with a fully-formed `SpeakerChangeEvent` on each transition.
 *
 * Returns `{ stop }` — the caller owns teardown.
 */
export function startSpeakerScraper(
  page: ScraperPage,
  onChange: (event: SpeakerChangeEvent) => void,
  opts: ScraperOptions,
): SpeakerScraperHandle {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const meetingId = opts.meetingId;

  // Track the last-emitted speaker so we can dedupe consecutive identical
  // activations. `null` means we haven't emitted anything yet (including
  // during a same-speaker re-announce at t=0, which is still a no-op).
  let lastSpeakerId: string | null = null;
  let stopped = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  // Unique identifier for this scraper instance's in-page globals. Using a
  // counter (instead of e.g. a timestamp) keeps the name deterministic for
  // tests and avoids collisions when two scrapers start in the same tick.
  const instanceId = ++exposeCounter;
  const exposedName = `__meetBotSpeakerChange_${instanceId}__`;
  const observerGlobal = `__meetBotSpeakerObserver_${instanceId}__`;

  /**
   * Dedupe + forward. Both the MutationObserver-driven path and the
   * polling-fallback path funnel through here so we can't double-emit even
   * if both fire for the same transition.
   */
  const handleSnapshot = (snapshot: SpeakerTileSnapshot | null): void => {
    if (stopped) return;
    if (!snapshot) return;
    if (snapshot.speakerId === lastSpeakerId) return;

    lastSpeakerId = snapshot.speakerId;

    // `SpeakerChangeEventSchema` types `timestamp` as a non-empty string,
    // so we format "now" as ISO-8601. Downstream consumers can
    // `Date.parse(event.timestamp)` to recover millis if needed.
    const event: SpeakerChangeEvent = {
      type: "speaker.change",
      meetingId,
      timestamp: new Date().toISOString(),
      speakerId: snapshot.speakerId,
      speakerName: snapshot.speakerName,
    };

    try {
      onChange(event);
    } catch {
      // Never let a caller's error crash the scraper — the caller's
      // observability pipeline is responsible for reporting onChange
      // failures.
    }
  };

  // ----- Primary path: in-page MutationObserver -----

  // Expose the Node-side callback so the observer can call it directly.
  // Best-effort — if `exposeFunction` fails (page closed, duplicate name,
  // etc.), the polling fallback still guarantees we emit events.
  void page
    .exposeFunction(exposedName, (snapshot: SpeakerTileSnapshot | null) => {
      handleSnapshot(snapshot);
    })
    .catch(() => {
      // Swallow — polling fallback covers us.
    });

  // Install the MutationObserver. Track the promise so stop() can wait for
  // it and tear down any late-installed observer.
  const observerInstalled = page
    .evaluate(
      ({ selector, callbackName, observerName }) => {
        // Skip if somehow already installed (e.g. hot reload, duplicate
        // start). We key on a window-level global keyed by observerName.
        const w = window as unknown as Record<string, unknown>;
        if (w[observerName]) return;

        const extractSnapshot = (): {
          speakerId: string;
          speakerName: string;
        } | null => {
          const tile = document.querySelector(selector);
          if (!tile) return null;
          const speakerId = tile.getAttribute("data-participant-id") ?? "";
          if (!speakerId) return null;
          // Prefer the in-tile name label; fall back to the tile's aria /
          // text content. Keeping this mirror-image simple — callers
          // downstream can normalize or enrich with participant-panel
          // info (see PR 21's speaker resolver).
          const nameEl =
            tile.querySelector("[data-participant-name]") ??
            tile.querySelector("[data-self-name]") ??
            tile.querySelector(".tile-name");
          const speakerName =
            nameEl?.textContent?.trim() ??
            tile.getAttribute("aria-label")?.trim() ??
            "";
          return { speakerId, speakerName };
        };

        const callback = w[callbackName] as
          | ((
              snapshot: { speakerId: string; speakerName: string } | null,
            ) => void)
          | undefined;

        // Emit the initial active speaker (if any) so Node-side state is
        // primed. Dedupe on the Node side means this is a no-op unless the
        // page already has a speaker highlighted at scraper-start.
        if (callback) callback(extractSnapshot());

        const observer = new MutationObserver(() => {
          const fresh = w[callbackName] as
            | ((
                snapshot: { speakerId: string; speakerName: string } | null,
              ) => void)
            | undefined;
          if (fresh) fresh(extractSnapshot());
        });

        observer.observe(document.body, {
          subtree: true,
          attributes: true,
          attributeFilter: ["data-active-speaker"],
          childList: true,
        });

        w[observerName] = observer;
      },
      {
        selector: INGAME_ACTIVE_SPEAKER_INDICATOR,
        callbackName: exposedName,
        observerName: observerGlobal,
      },
    )
    .catch(() => {
      // Swallow — the polling fallback still emits transitions.
    });

  // If stop() was called while the observer was being installed, tear
  // down the late observer immediately.
  void observerInstalled.then(() => {
    if (stopped && !page.isClosed()) {
      void page
        .evaluate((observerName) => {
          const w = window as unknown as Record<string, unknown>;
          const observer = w[observerName] as
            | { disconnect: () => void }
            | undefined;
          if (observer && typeof observer.disconnect === "function") {
            observer.disconnect();
          }
          delete w[observerName];
        }, observerGlobal)
        .catch(() => {});
    }
  });

  // ----- Fallback path: Node-side polling of the same selector -----

  const pollOnce = async (): Promise<void> => {
    if (stopped) return;
    if (page.isClosed()) return;
    try {
      const snapshot = await page.evaluate((selector) => {
        const tile = document.querySelector(selector);
        if (!tile) return null;
        const speakerId = tile.getAttribute("data-participant-id") ?? "";
        if (!speakerId) return null;
        const nameEl =
          tile.querySelector("[data-participant-name]") ??
          tile.querySelector("[data-self-name]") ??
          tile.querySelector(".tile-name");
        const speakerName =
          nameEl?.textContent?.trim() ??
          tile.getAttribute("aria-label")?.trim() ??
          "";
        return { speakerId, speakerName };
      }, INGAME_ACTIVE_SPEAKER_INDICATOR);
      handleSnapshot(snapshot);
    } catch {
      // Page may have navigated or closed between ticks; skip this tick
      // and let the next one retry.
    }
  };

  pollTimer = setInterval(() => {
    void pollOnce();
  }, pollMs);

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }

      // Best-effort teardown of the in-page observer. We don't wait on it
      // because `stop()` is synchronous by contract and the callback
      // pipeline is already short-circuited by the `stopped` flag.
      if (!page.isClosed()) {
        void page
          .evaluate((observerName) => {
            const w = window as unknown as Record<string, unknown>;
            const observer = w[observerName] as
              | { disconnect: () => void }
              | undefined;
            if (observer && typeof observer.disconnect === "function") {
              observer.disconnect();
            }
            delete w[observerName];
          }, observerGlobal)
          .catch(() => {
            // Swallow.
          });
      }

      // We intentionally leave the exposed function registered — Playwright
      // doesn't expose an `unexposeFunction`, and the instance-unique name
      // means it cannot collide with a later scraper. The `stopped` flag
      // prevents any late in-page callback from reaching `onChange`.
    },
  };
}
