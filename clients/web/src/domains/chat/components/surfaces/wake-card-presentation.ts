/**
 * How a wake card is titled and summarised, and the test for which cards get
 * that treatment. The presentation registry for wakes, in the same spirit as
 * `utils/channel-presentation.tsx` for channels.
 *
 * A wake card announces that something other than the user made the assistant
 * take a turn: a workflow finished, a schedule fired, a long-running command
 * came back. Its body is the daemon's raw wake hint, a machine-written report
 * carrying run ids, token counts, and a JSON result tail (see
 * `buildCompletionSummary` in `assistant/src/workflows/run-manager.ts`).
 *
 * Both the title and the recap are derived here rather than taken from the
 * payload on purpose. The daemon titles every one of these "Conversation
 * Woke", which is internal vocabulary for the mechanism instead of an answer
 * to the question the card exists to answer, and that string is already baked
 * into every wake card in every conversation's history. Deriving the title
 * from the wake's source fixes those too, and puts the words in the i18n
 * catalogs where the rest of the UI's copy lives.
 */

import type { ParseKeys } from "@/i18n";
import type { Surface } from "@/domains/chat/types/types";

/**
 * Longest recap drawn on the card. Past this the line is cut at a word
 * boundary, since a "recap" that wraps to three lines is the thing this
 * replaces.
 */
const MAX_RECAP_CHARS = 120;

/**
 * Both wake emitters (`agent-wake.ts` and `wake-conversation-ops.ts`) build
 * the surface id the same way, and it is the only part of the payload that is
 * not display copy: the title is a user-visible string that translation or a
 * copy edit could move, while the id is structural.
 */
const WAKE_SURFACE_ID_PREFIX = "wake-";

/**
 * The metadata label the daemon files the wake's trigger under. English and
 * daemon-authored, matched case-insensitively, with the first metadata entry
 * as the fallback so a relabelled payload still finds its source.
 */
const SOURCE_LABEL = "source";

/**
 * Title per wake source: what happened, rather than that a wake happened.
 *
 * Sources come from the `wakeAgentForOpportunity()` call sites. An unlisted
 * one falls back to {@link FALLBACK_TITLE_KEY}, which is true of every wake
 * and says the useful half of it, so a new trigger reads acceptably before it
 * gets an entry here.
 */
const TITLE_KEYS: Record<string, ParseKeys<"chat">> = {
  workflow_completed: "wakeCard.workflowFinished",
  // `schedule` is a schedule run by hand through `schedules/:id/run`; `defer`
  // is the scheduler's own due-tick, which is how a scheduled wake normally
  // arrives. Both are the same event to a reader.
  schedule: "wakeCard.scheduledRun",
  defer: "wakeCard.scheduledRun",
  "background-tool": "wakeCard.commandFinished",
  "memory-retrospective": "wakeCard.memoryReview",
  "memory-retrospective-fork": "wakeCard.memoryReview",
  "watch-retro": "wakeCard.watchReview",
  "interrupted-turn-resume": "wakeCard.resumed",
  webhook: "wakeCard.incomingEvent",
};

const FALLBACK_TITLE_KEY: ParseKeys<"chat"> = "wakeCard.ranOnItsOwn";

/** Whether a card surface is one of the daemon's wake announcements. */
export function isWakeCardSurface(surface: Surface): boolean {
  return (
    surface.surfaceType === "card" &&
    surface.surfaceId.startsWith(WAKE_SURFACE_ID_PREFIX)
  );
}

/** The wake's trigger, read off the card's metadata. */
export function wakeCardSource(
  metadata: ReadonlyArray<{ label: string; value: string }>,
): string | undefined {
  const entry =
    metadata.find((item) => item.label.toLowerCase() === SOURCE_LABEL) ??
    metadata[0];
  return entry?.value;
}

/** The i18n key naming what woke the conversation. */
export function wakeCardTitleKey(source: string | undefined): ParseKeys<"chat"> {
  return (source && TITLE_KEYS[source]) || FALLBACK_TITLE_KEY;
}

/**
 * Cut `text` to {@link MAX_RECAP_CHARS}, at the last word boundary that fits
 * rather than mid-word. A single long word with no boundary is cut where the
 * budget runs out, since the alternative is returning the whole thing.
 */
function truncate(text: string): string {
  if (text.length <= MAX_RECAP_CHARS) {
    return text;
  }
  const clipped = text.slice(0, MAX_RECAP_CHARS);
  const lastSpace = clipped.lastIndexOf(" ");
  const stem = lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped;
  return `${stem.replace(/[.,;:]$/, "")}…`;
}

/**
 * A daemon tag line: a kind, the thing's own name in quotes, and a status,
 * all inside brackets. `[workflow "Classify use cases" completed]`.
 */
const TAGGED_LINE = /^\[\s*[\w-]+\s+"(.+)"\s+[\w-]+\s*\]$/;

/**
 * The recap line for a wake body.
 *
 * Reads the first non-empty line, which is where every wake hint puts its
 * summary. A daemon tag line collapses to the quoted name alone: the kind and
 * the status are what the title now says, so repeating them would leave the
 * card saying "Workflow finished / Workflow "x" completed". Falls back to the
 * first sentence when the body arrived as one unbroken paragraph.
 *
 * Returns an empty string for an empty body, which the card treats as "draw
 * no recap" rather than an empty line.
 */
export function wakeCardRecap(body: string): string {
  const firstLine = body
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) {
    return "";
  }

  const tagged = TAGGED_LINE.exec(firstLine)?.[1]?.trim();
  if (tagged) {
    return truncate(tagged);
  }

  const unwrapped = /^\[(.+)\]$/.exec(firstLine)?.[1]?.trim() ?? firstLine;

  // One unbroken paragraph: take the first sentence so the recap is a
  // sentence rather than the opening of one.
  const sentence =
    unwrapped.length > MAX_RECAP_CHARS
      ? (/^(.+?[.!?])\s/.exec(unwrapped)?.[1] ?? unwrapped)
      : unwrapped;

  const trimmed = sentence.replace(/\.$/, "");
  return truncate(trimmed.charAt(0).toUpperCase() + trimmed.slice(1));
}

// ---------------------------------------------------------------------------
// Hint parsing
// ---------------------------------------------------------------------------

/**
 * A workflow wake hint, split into the things it actually reports.
 *
 * The daemon writes these lines in `buildCompletionSummary`
 * (`assistant/src/workflows/run-manager.ts`): a tag line naming the workflow,
 * a run line, a counts line, and a result-or-outcome tail. Read apart, each is
 * a field worth its own row; read together, they are the wall of text this
 * splits up.
 *
 * Every line that does not match one of those shapes lands in `rest`, so a
 * hint from another wake source (a schedule's own message, a webhook payload)
 * comes back whole under a single heading rather than being silently dropped.
 */
export interface WakeHintSections {
  /** The workflow's own name, from the tag line. */
  workflow?: string;
  /** The daemon's run and counts lines, as it wrote them. */
  runStatus?: string;
  /** The run's id, which is how the run is looked up. */
  runId?: string;
  /** The result or outcome tail, unparsed. */
  result?: string;
  /** Everything that matched nothing, which for a non-workflow hint is all of it. */
  rest?: string;
}

const RUN_LINE = /^Run\s+(\S+)\s+finished with status:/;
const COUNTS_LINE = /^Agents spawned:/;
const RESULT_LINE = /^(?:Result|Outcome):\s*/;

/** Split a wake hint into the fields a reader would want as separate rows. */
export function parseWakeHint(body: string): WakeHintSections {
  const lines = body.split("\n");
  const sections: WakeHintSections = {};
  const runStatus: string[] = [];
  const rest: string[] = [];
  const result: string[] = [];
  let inResult = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // The result tail runs to the end of the hint: a JSON payload can carry
    // newlines of its own, and each of those is result, not a new field.
    if (inResult) {
      result.push(line);
      continue;
    }

    if (!trimmed) {
      if (rest.length > 0) {
        rest.push(line);
      }
      continue;
    }

    const tagged = TAGGED_LINE.exec(trimmed)?.[1]?.trim();
    if (tagged && !sections.workflow) {
      sections.workflow = tagged;
      continue;
    }

    const runId = RUN_LINE.exec(trimmed)?.[1];
    if (runId) {
      sections.runId = runId;
      runStatus.push(trimmed);
      continue;
    }

    if (COUNTS_LINE.test(trimmed)) {
      runStatus.push(trimmed);
      continue;
    }

    if (RESULT_LINE.test(trimmed)) {
      inResult = true;
      result.push(trimmed.replace(RESULT_LINE, ""));
      continue;
    }

    rest.push(line);
  }

  if (runStatus.length > 0) {
    sections.runStatus = runStatus.join("\n");
  }
  const resultText = result.join("\n").trim();
  if (resultText) {
    sections.result = resultText;
  }
  const restText = rest.join("\n").trim();
  if (restText) {
    sections.rest = restText;
  }
  return sections;
}

/**
 * A result payload rendered as rows: one per field of the object the workflow
 * returned. `null` when the payload is not JSON the panel can lay out, in
 * which case the caller shows the text as it arrived, which is what a
 * truncated result tail needs.
 */
export type ResultRow = { key: string; value: string };
export type ResultGroup = ResultRow[];

/** Turn `evidence_note` into `Evidence note`. Structural, not translated. */
function humanizeKey(key: string): string {
  const words = key.split(/[_\s-]+/).filter(Boolean).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function renderValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value, null, 2);
}

/**
 * Lay a workflow result out as labelled rows.
 *
 * A workflow's result is JSON, and the shape that keeps turning up is an array
 * holding one object per thing the run classified. Those become one group of
 * rows each, so `{"confidence":"low","evidence_note":"..."}` reads as two
 * labelled lines instead of a quoted blob.
 *
 * Returns `null` for anything that is not JSON (a truncated tail, an error
 * string), leaving the caller to show the raw text rather than a wrong guess
 * at its structure.
 */
export function parseResultPayload(result: string): ResultGroup[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return null;
  }

  const items = Array.isArray(parsed) ? parsed : [parsed];
  const groups: ResultGroup[] = [];
  for (const item of items) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      // A bare value carries no field name of its own, so there is nothing to
      // label it with and the raw text reads better.
      return null;
    }
    groups.push(
      Object.entries(item).map(([key, value]) => ({
        key: humanizeKey(key),
        value: renderValue(value),
      })),
    );
  }
  return groups.length > 0 ? groups : null;
}
