/**
 * Participant-panel scraper.
 *
 * Polls Google Meet's "People" side panel every `pollMs` milliseconds, diffs
 * the current roster against the previous snapshot (by participant id), and
 * emits a `ParticipantChangeEvent` whenever participants join or leave.
 *
 * Design notes:
 *
 *   - Meet collapses the participant panel by default. On `startParticipantScraper`
 *     we check whether the list container is already mounted (`INGAME_PARTICIPANT_LIST`)
 *     and only click the panel toggle if it is not. Without this guard, clicking
 *     an already-open panel would *close* it.
 *   - We read participant rows via `page.$$eval` and extract `{ id, name }` from
 *     each row. The stable id comes from `data-participant-id`; the name is
 *     pulled from the `data-participant-name` / `data-self-name` subselector.
 *     We only fall back to using the name as the id when the row has no stable
 *     attribute (see TODO below).
 *   - The first successful poll treats *every* current participant as `joined`
 *     (initial snapshot). Subsequent polls only emit participants whose id
 *     set differs from the previous snapshot. That keeps downstream consumers
 *     (conversation bridge, storage writer) from having to special-case the
 *     "first event" vs. "delta event".
 *   - Errors during a poll (e.g. selector timeout, panel auto-collapsed) are
 *     swallowed so a transient DOM glitch doesn't kill the scraper. The next
 *     poll will retry.
 *
 * Downstream consumers:
 *
 *   - PR 17 — conversation bridge (writes join/leave messages)
 *   - PR 18 — storage writer (snapshots participants.json)
 */

import type { Page } from "playwright";

import type { Participant, ParticipantChangeEvent } from "@vellumai/meet-contracts";

import { selectors } from "./dom-selectors.js";

/** Options for {@link startParticipantScraper}. */
export interface ParticipantScraperOptions {
  /** Meeting identifier embedded in every emitted event. */
  meetingId: string;
  /** Poll interval in milliseconds. Defaults to 1000. */
  pollMs?: number;
}

/** Handle returned by {@link startParticipantScraper}. */
export interface ParticipantScraperHandle {
  /** Cancel the polling interval. Safe to call multiple times. */
  stop: () => void;
}

/** Shape returned by the in-page `$$eval` extractor. */
interface ScrapedRow {
  id: string | null;
  name: string | null;
}

/**
 * Start polling the participant panel and invoke `onChange` whenever the
 * participant set changes.
 *
 * The first poll emits a `ParticipantChangeEvent` with every currently-visible
 * participant in `joined` and an empty `left`. Subsequent polls only fire when
 * the id-set differs.
 *
 * @returns A handle whose `stop()` method cancels the poll interval.
 */
export function startParticipantScraper(
  page: Page,
  onChange: (event: ParticipantChangeEvent) => void,
  opts: ParticipantScraperOptions = { meetingId: "" },
): ParticipantScraperHandle {
  const pollMs = opts.pollMs ?? 1000;
  const meetingId = opts.meetingId;

  /**
   * Snapshot of the previous poll keyed by participant id, so we can
   * build the joined/left diffs efficiently and preserve the full
   * participant object for departed rows (which won't be in the current
   * DOM anymore).
   */
  let previous: Map<string, Participant> = new Map();
  let firstPollComplete = false;
  let stopped = false;

  const poll = async (): Promise<void> => {
    if (stopped) return;

    let rows: ScrapedRow[];
    try {
      // Open the participants panel if it isn't already. Checking the list
      // container first avoids toggling a panel that is already visible.
      const alreadyOpen = await page.$(selectors.INGAME_PARTICIPANT_LIST);
      if (!alreadyOpen) {
        const toggle = await page.$(selectors.INGAME_PARTICIPANTS_PANEL_BUTTON);
        if (toggle) {
          await toggle.click();
        }
      }

      rows = await page.$$eval(
        selectors.INGAME_PARTICIPANT_NODE,
        (nodes, nameSelector) =>
          nodes.map((node) => {
            const el = node as HTMLElement;
            const id = el.getAttribute("data-participant-id");
            const nameEl = el.querySelector(nameSelector);
            const name =
              (nameEl?.textContent ?? "").trim() || null;
            return { id: id ?? null, name };
          }),
        selectors.INGAME_PARTICIPANT_NAME,
      );
    } catch {
      // Transient DOM error (navigation, panel auto-closed, etc.). Skip this
      // tick and try again next interval.
      return;
    }

    const current = new Map<string, Participant>();
    for (const row of rows) {
      const name = row.name ?? "";
      // Prefer the stable `data-participant-id` attribute. If Meet hasn't
      // attached one to this row, fall back to using the name as the id.
      // TODO(meet-dom): drop the name-as-id fallback once we confirm Meet
      // always emits a stable id on every participant row. For MVP this
      // keeps the scraper resilient to partially-rendered rows.
      const id = row.id ?? name;
      if (!id) continue;
      current.set(id, { id, name });
    }

    // First poll: everyone currently visible is a "joined" participant from
    // the scraper's perspective. Subsequent polls compute deltas against the
    // previous snapshot.
    const joined: Participant[] = [];
    const left: Participant[] = [];

    if (!firstPollComplete) {
      for (const participant of current.values()) {
        joined.push(participant);
      }
    } else {
      for (const [id, participant] of current) {
        if (!previous.has(id)) joined.push(participant);
      }
      for (const [id, participant] of previous) {
        if (!current.has(id)) left.push(participant);
      }
    }

    previous = current;
    firstPollComplete = true;

    if (joined.length === 0 && left.length === 0) return;

    const event: ParticipantChangeEvent = {
      type: "participant.change",
      meetingId,
      timestamp: new Date().toISOString(),
      joined,
      left,
    };
    onChange(event);
  };

  const timer = setInterval(() => {
    void poll();
  }, pollMs);
  // Kick off the first poll immediately so callers don't have to wait a
  // full interval for the initial snapshot.
  void poll();

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}
