/**
 * DOM active-speaker scraper, content-script flavor.
 *
 * Watches Google Meet's participant-tile grid for changes to the
 * active-speaker indicator ({@link INGAME_ACTIVE_SPEAKER_INDICATOR}) and
 * emits a {@link SpeakerChangeEvent} every time the active speaker
 * transitions to a new participant.
 *
 * ## Strategy
 *
 * This module is the in-page descendant of the former Playwright-driven
 * `bot/src/browser/speaker-scraper.ts`. Because the Manifest V3 content
 * script already runs inside Meet's page world, we can install the
 * `MutationObserver` directly against `document.body` and skip the
 * `page.evaluate` / `page.exposeFunction` bridge. That removes the reason
 * the bot-side scraper carried a Node-side polling fallback — the bridge
 * no longer exists, so there is nothing to fall back from.
 *
 * Meet toggles `data-active-speaker="true"` on exactly one participant
 * tile at a time. Every observed attribute change triggers a single
 * `document.querySelector(INGAME_ACTIVE_SPEAKER_INDICATOR)` lookup to find
 * the current active tile; we dedupe by `speakerId` so a repeat activation
 * of the same speaker produces no event.
 *
 * ## Contract
 *
 * - Only emits events on transitions. A static fixture (no active-speaker
 *   changes) must produce zero events, no matter how long we observe.
 * - The initial active speaker (if any) is reported as the first event so
 *   downstream state can be primed at scraper start.
 * - Emits `SpeakerChangeEvent` with `timestamp` as an ISO-8601 string so
 *   the payload validates against `SpeakerChangeEventSchema`.
 * - `stop()` is idempotent and must not throw; subsequent invocations are
 *   no-ops.
 */

import type { SpeakerChangeEvent } from "../../../contracts/index.js";

import { INGAME_ACTIVE_SPEAKER_INDICATOR } from "../dom/selectors.js";

/**
 * Payload captured from the active-speaker tile. Kept deliberately small
 * so the outbound `SpeakerChangeEvent` is a thin wrapper around it.
 */
export interface SpeakerTileSnapshot {
  speakerId: string;
  speakerName: string;
}

export interface SpeakerScraperOptions {
  /** Meeting ID stamped onto every emitted event. */
  meetingId: string;
  /**
   * Callback invoked with every {@link SpeakerChangeEvent} the scraper
   * detects. In production this forwards via `chrome.runtime.sendMessage`
   * so the background service worker can relay it over the native port;
   * tests supply an in-memory collector.
   */
  onEvent: (event: SpeakerChangeEvent) => void;
}

export interface SpeakerScraperHandle {
  /**
   * Stop the scraper. Disconnects the observer. Idempotent — calling
   * twice is safe.
   */
  stop: () => void;
}

/**
 * Extract a {@link SpeakerTileSnapshot} from the current DOM. Returns
 * `null` when no tile has `data-active-speaker="true"` or when the
 * active tile lacks a stable participant id.
 */
function extractActiveSpeaker(doc: Document): SpeakerTileSnapshot | null {
  const tile = doc.querySelector(INGAME_ACTIVE_SPEAKER_INDICATOR);
  if (!tile) return null;
  const speakerId = tile.getAttribute("data-participant-id") ?? "";
  if (!speakerId) return null;
  // Prefer the in-tile name label; fall back to the tile's aria / text
  // content. Keeping this mirror-image simple — callers downstream can
  // normalize or enrich with participant-panel info.
  const nameEl =
    tile.querySelector("[data-participant-name]") ??
    tile.querySelector("[data-self-name]") ??
    tile.querySelector(".tile-name");
  const speakerName =
    nameEl?.textContent?.trim() ??
    tile.getAttribute("aria-label")?.trim() ??
    "";
  return { speakerId, speakerName };
}

/**
 * Begin observing active-speaker transitions on the current page and
 * invoke `opts.onEvent` with a fully-formed {@link SpeakerChangeEvent}
 * on each transition.
 *
 * Returns `{ stop }` — the caller owns teardown.
 */
export function startSpeakerScraper(
  opts: SpeakerScraperOptions,
): SpeakerScraperHandle {
  const { meetingId, onEvent } = opts;

  // Track the last-emitted speaker so we can dedupe consecutive identical
  // activations. `null` means we haven't emitted anything yet.
  let lastSpeakerId: string | null = null;
  let stopped = false;

  /**
   * Dedupe + forward. All observer callbacks (initial + every mutation)
   * funnel through here so we can't double-emit even if Meet patches the
   * same tile multiple times in quick succession.
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
      onEvent(event);
    } catch {
      // Never let a caller's error crash the scraper — the caller's
      // observability pipeline is responsible for reporting onEvent
      // failures.
    }
  };

  // Emit the initial active speaker (if any) so downstream state is
  // primed. Dedupe below means this is a no-op unless the page already
  // has a speaker highlighted at scraper-start.
  handleSnapshot(extractActiveSpeaker(document));

  const observer = new MutationObserver(() => {
    handleSnapshot(extractActiveSpeaker(document));
  });

  observer.observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ["data-active-speaker"],
    childList: true,
  });

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      observer.disconnect();
    },
  };
}
