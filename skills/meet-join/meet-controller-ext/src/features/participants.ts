/**
 * Participant-panel scraper (content-script port).
 *
 * Ports `skills/meet-join/bot/src/browser/participant-scraper.ts` from the
 * Playwright-driven page-world implementation into the Manifest V3 content
 * script. The polling/diff logic is intentionally identical — only the
 * substrate differs: where the bot-side code used `page.$` and `page.$$eval`
 * to reach into the page world, this module runs *inside* the page world
 * and reads the DOM directly via `document.querySelector*`.
 *
 * Design notes (mirrors the bot-side implementation):
 *
 *   - Meet collapses the participant panel by default. On
 *     `startParticipantScraper` we check whether the list container is
 *     already mounted (`INGAME_PARTICIPANT_LIST`) and only click the panel
 *     toggle if it is not. Without this guard, clicking an already-open
 *     panel would *close* it.
 *   - We read participant rows via `document.querySelectorAll` and extract
 *     `{ id, name, isSelfByDom }` from each row. The stable id comes from
 *     `data-participant-id`; the name is pulled from the
 *     `data-participant-name` / `data-self-name` subselector. We only fall
 *     back to using the name as the id when the row has no stable attribute.
 *   - The first successful poll treats *every* current participant as `joined`
 *     (initial snapshot). Subsequent polls only emit participants whose id
 *     set differs from the previous snapshot. That keeps downstream consumers
 *     (conversation bridge, storage writer) from having to special-case the
 *     "first event" vs. "delta event".
 *   - Errors during a poll (e.g. selector timeout, panel auto-collapsed) are
 *     swallowed so a transient DOM glitch doesn't kill the scraper. The next
 *     poll will retry.
 *
 * Events flow: this module calls the caller-supplied `onEvent` callback with
 * a `ParticipantChangeEvent`. In `content.ts` the callback is wired to
 * `chrome.runtime.sendMessage` so the event flows
 * content → background → native-port → bot.
 */

import type { ExtensionToBotMessage } from "../../../contracts/native-messaging.js";
import type { Participant } from "../../../contracts/events.js";
import { selectors } from "../dom/selectors.js";

/** Options for {@link startParticipantScraper}. */
export interface ParticipantScraperOptions {
  /** Meeting identifier embedded in every emitted event. */
  meetingId: string;
  /** Poll interval in milliseconds. Defaults to 2000. */
  pollMs?: number;
  /**
   * Display name the bot joined the meeting under. When provided, the
   * scraper flags the matching row with `isSelf: true` so downstream
   * consumers (e.g. the consent monitor) can identify the bot's own
   * participant id.
   *
   * The scraper prefers Meet's authoritative DOM signal — the name
   * element carrying `data-self-name` rather than `data-participant-name`
   * — and falls back to comparing the row's display name with this value
   * when the DOM attribute is absent. The name fallback is safe for the
   * bot (which picks a deliberately unique display name) but would be
   * fragile for arbitrary humans.
   */
  selfName?: string;
  /**
   * Callback invoked whenever the participant set changes. In the real
   * extension this is bound to `chrome.runtime.sendMessage`; tests pass
   * a plain function that records events for assertion.
   */
  onEvent: (event: ExtensionToBotMessage) => void;
}

/** Handle returned by {@link startParticipantScraper}. */
export interface ParticipantScraperHandle {
  /** Cancel the polling interval. Safe to call multiple times. */
  stop: () => void;
}

/** Shape returned by the per-row extractor. */
interface ScrapedRow {
  id: string | null;
  name: string | null;
  /**
   * True when the row's name node was matched via `data-self-name` —
   * Meet's own marker for the signed-in / joining user's row. Undefined
   * when the DOM signal is absent; the caller may still flag the row by
   * name match in that case.
   */
  isSelfByDom: boolean;
}

/** Default poll interval. Matches the plan: 2s. */
const DEFAULT_POLL_MS = 2_000;

/**
 * Read every visible participant row from the participants panel. Returns
 * an empty array if the panel container isn't mounted.
 *
 * Kept as a free function so the core "extract rows from the current
 * document" logic can be reasoned about (and, in principle, unit-tested)
 * independently of the polling harness.
 */
function scrapeRows(): ScrapedRow[] {
  const nodes = document.querySelectorAll(selectors.INGAME_PARTICIPANT_NODE);
  const rows: ScrapedRow[] = [];
  for (const node of Array.from(nodes)) {
    const el = node as HTMLElement;
    const id = el.getAttribute("data-participant-id");
    const nameEl = el.querySelector(selectors.INGAME_PARTICIPANT_NAME);
    const name = (nameEl?.textContent ?? "").trim() || null;
    // Meet marks the signed-in / joining user's row with `data-self-name`
    // instead of `data-participant-name`. We use this authoritative marker
    // to flag the bot's own row; callers may additionally match by
    // display name.
    const isSelfByDom =
      nameEl instanceof HTMLElement && nameEl.hasAttribute("data-self-name");
    rows.push({ id: id ?? null, name, isSelfByDom });
  }
  return rows;
}

/**
 * Ensure the participants panel is open. Checking the list container first
 * avoids toggling a panel that is already visible (which would close it).
 */
function ensurePanelOpen(): void {
  const alreadyOpen = document.querySelector(selectors.INGAME_PARTICIPANT_LIST);
  if (alreadyOpen) return;
  const toggle = document.querySelector<HTMLElement>(
    selectors.INGAME_PARTICIPANTS_PANEL_BUTTON,
  );
  if (toggle) toggle.click();
}

/**
 * Start polling the participant panel and invoke `onEvent` whenever the
 * participant set changes.
 *
 * The first poll emits a `ParticipantChangeEvent` with every currently-visible
 * participant in `joined` and an empty `left`. Subsequent polls only fire when
 * the id-set differs.
 *
 * @returns A handle whose `stop()` method cancels the poll interval.
 */
export function startParticipantScraper(
  opts: ParticipantScraperOptions,
): ParticipantScraperHandle {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const meetingId = opts.meetingId;
  const selfName = opts.selfName;
  const onEvent = opts.onEvent;

  /**
   * Snapshot of the previous poll keyed by participant id, so we can build
   * the joined/left diffs efficiently and preserve the full participant
   * object for departed rows (which won't be in the current DOM anymore).
   */
  let previous: Map<string, Participant> = new Map();
  let firstPollComplete = false;
  let stopped = false;

  const poll = (): void => {
    if (stopped) return;

    let rows: ScrapedRow[];
    try {
      ensurePanelOpen();
      rows = scrapeRows();
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
      // Flag the bot's own row so downstream consumers (consent monitor,
      // watermark tracker) can filter out bot-self transcripts and chat.
      // Prefer Meet's authoritative DOM signal (`data-self-name`); fall
      // back to matching the configured bot display name when the DOM
      // marker is absent.
      const isSelf =
        row.isSelfByDom ||
        (selfName !== undefined && name !== "" && name === selfName);
      const participant: Participant = isSelf
        ? { id, name, isSelf: true }
        : { id, name };
      current.set(id, participant);
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
    if (stopped) return;

    onEvent({
      type: "participant.change",
      meetingId,
      timestamp: new Date().toISOString(),
      joined,
      left,
    });
  };

  const timer = setInterval(poll, pollMs);
  // Kick off the first poll immediately so callers don't have to wait a
  // full interval for the initial snapshot.
  poll();

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}
