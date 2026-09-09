/**
 * Tests for the wake card's recap derivation.
 *
 * The fixtures are real wake-hint shapes: the workflow summary the daemon
 * builds in `buildCompletionSummary`, and the single-paragraph hints other
 * wake sources send.
 */

import { describe, expect, test } from "bun:test";

import type { Surface } from "@/domains/chat/types/types";
import {
  isWakeCardSurface,
  parseResultPayload,
  parseWakeHint,
  wakeCardRecap,
  wakeCardSource,
  wakeCardTitleKey,
} from "@/domains/chat/components/surfaces/wake-card-presentation";

const WORKFLOW_HINT = [
  '[workflow "Classify observed subscriber use cases" completed]',
  "Run 387bfa70-4ba4-47be-b223-10922bf740cc finished with status: completed.",
  "Agents spawned: 1. Tokens: 608 in / 213 out.",
  'Result: [{"confidence":"low","email":"stub"}]',
].join("\n");

function cardSurface(surfaceId: string): Surface {
  return { surfaceId, surfaceType: "card" } as Surface;
}

describe("isWakeCardSurface", () => {
  test("recognises a wake card by its structural id", () => {
    expect(isWakeCardSurface(cardSurface("wake-conv-123-1700000000"))).toBe(
      true,
    );
  });

  test("leaves other card surfaces alone", () => {
    expect(isWakeCardSurface(cardSurface("card-access-request"))).toBe(false);
  });

  test("does not claim a non-card surface that happens to be named wake", () => {
    const surface = { surfaceId: "wake-1", surfaceType: "form" } as Surface;
    expect(isWakeCardSurface(surface)).toBe(false);
  });
});

describe("wakeCardRecap", () => {
  test("collapses a daemon tag line to the thing's own name", () => {
    // WHEN a workflow wake arrives with its run detail below the summary
    // THEN the recap is the workflow's name: the kind and the status are what
    // the card's title already says
    expect(wakeCardRecap(WORKFLOW_HINT)).toBe(
      "Classify observed subscriber use cases",
    );
  });

  test("keeps the run detail out of the recap", () => {
    const recap = wakeCardRecap(WORKFLOW_HINT);
    expect(recap).not.toContain("387bfa70");
    expect(recap).not.toContain("Tokens");
  });

  test("capitalises the line and drops a trailing period", () => {
    expect(wakeCardRecap("a schedule fired.")).toBe("A schedule fired");
  });

  test("takes the first sentence of a long single paragraph", () => {
    const paragraph =
      "The nightly sweep finished. It archived 42 newsletters, unsubscribed " +
      "from 3 senders, and left everything else where it was because the " +
      "rules did not match.";
    expect(wakeCardRecap(paragraph)).toBe("The nightly sweep finished");
  });

  test("cuts an over-long line at a word boundary", () => {
    const recap = wakeCardRecap(`${"alpha ".repeat(40)}omega`);
    expect(recap.length).toBeLessThanOrEqual(121);
    expect(recap.endsWith("…")).toBe(true);
    expect(recap).not.toContain("alp…");
  });

  test("skips leading blank lines", () => {
    expect(wakeCardRecap("\n\n  Slack thread replied\nmore detail")).toBe(
      "Slack thread replied",
    );
  });

  test("returns nothing for an empty body, so the card draws no recap", () => {
    expect(wakeCardRecap("   \n  ")).toBe("");
  });
});

describe("wakeCardSource", () => {
  test("reads the trigger off the Source entry", () => {
    expect(
      wakeCardSource([
        { label: "Run", value: "387bfa70" },
        { label: "Source", value: "workflow_completed" },
      ]),
    ).toBe("workflow_completed");
  });

  test("matches the label case-insensitively", () => {
    expect(wakeCardSource([{ label: "source", value: "schedule" }])).toBe(
      "schedule",
    );
  });

  test("falls back to the first entry when nothing is labelled Source", () => {
    expect(wakeCardSource([{ label: "Trigger", value: "webhook" }])).toBe(
      "webhook",
    );
  });

  test("has nothing to report for empty metadata", () => {
    expect(wakeCardSource([])).toBeUndefined();
  });
});

describe("wakeCardTitleKey", () => {
  test("names what happened, per source", () => {
    expect(wakeCardTitleKey("workflow_completed")).toBe(
      "wakeCard.workflowFinished",
    );
    expect(wakeCardTitleKey("schedule")).toBe("wakeCard.scheduledRun");
    expect(wakeCardTitleKey("background-tool")).toBe(
      "wakeCard.commandFinished",
    );
  });

  /* `schedule` is a hand-run schedule, `defer` the scheduler's own due tick.
     Different plumbing, same event to whoever reads the card. */
  test("both scheduled paths read as the same event", () => {
    expect(wakeCardTitleKey("defer")).toBe(wakeCardTitleKey("schedule"));
  });

  test("both memory retrospective paths read as the same event", () => {
    expect(wakeCardTitleKey("memory-retrospective-fork")).toBe(
      wakeCardTitleKey("memory-retrospective"),
    );
  });

  /* `tool_result` is an untrusted-content source, never a wake's own source,
     so it must not claim a title. */
  test("an untrusted-content source is not mistaken for a wake source", () => {
    expect(wakeCardTitleKey("tool_result")).toBe("wakeCard.ranOnItsOwn");
  });

  test("an unlisted or missing source still says the useful half", () => {
    expect(wakeCardTitleKey("something-new")).toBe("wakeCard.ranOnItsOwn");
    expect(wakeCardTitleKey(undefined)).toBe("wakeCard.ranOnItsOwn");
  });
});

describe("parseWakeHint", () => {
  test("splits a workflow hint into its own fields", () => {
    const sections = parseWakeHint(WORKFLOW_HINT);

    expect(sections.workflow).toBe("Classify observed subscriber use cases");
    expect(sections.runId).toBe("387bfa70-4ba4-47be-b223-10922bf740cc");
    expect(sections.runStatus).toContain("finished with status: completed");
    expect(sections.runStatus).toContain("Agents spawned: 1");
    expect(sections.result).toBe('[{"confidence":"low","email":"stub"}]');
    // Nothing is left over, so no catch-all field is drawn.
    expect(sections.rest).toBeUndefined();
  });

  test("keeps a failed run's outcome in the same slot as a result", () => {
    const sections = parseWakeHint(
      [
        '[workflow "Nightly sweep" failed]',
        "Run abc-123 finished with status: failed.",
        "Agents spawned: 0. Tokens: 0 in / 0 out.",
        "Outcome: the mailbox refused the connection",
      ].join("\n"),
    );

    expect(sections.result).toBe("the mailbox refused the connection");
  });

  test("keeps a multi-line result whole", () => {
    const sections = parseWakeHint(
      ["Result: {", '  "a": 1', "}"].join("\n"),
    );

    expect(sections.result).toBe('{\n  "a": 1\n}');
  });

  test("a hint from another wake source comes back whole", () => {
    const hint = "The nightly inbox sweep finished.\nIt archived 42 messages.";
    const sections = parseWakeHint(hint);

    expect(sections.rest).toBe(hint);
    expect(sections.workflow).toBeUndefined();
    expect(sections.runStatus).toBeUndefined();
    expect(sections.result).toBeUndefined();
  });
});

describe("parseResultPayload", () => {
  test("lays a returned object out as labelled rows", () => {
    const groups = parseResultPayload(
      '[{"confidence":"low","evidence_note":"No useable evidence."}]',
    );

    expect(groups).toEqual([
      [
        { key: "Confidence", value: "low" },
        { key: "Evidence note", value: "No useable evidence." },
      ],
    ]);
  });

  test("gives each object in an array its own group", () => {
    const groups = parseResultPayload('[{"a":1},{"a":2}]');
    expect(groups).toHaveLength(2);
  });

  test("takes a bare object as one group", () => {
    expect(parseResultPayload('{"use_case_1":"Insufficient"}')).toEqual([
      [{ key: "Use case 1", value: "Insufficient" }],
    ]);
  });

  test("renders a nested value rather than dropping it", () => {
    const groups = parseResultPayload('{"tags":["a","b"]}');
    expect(groups?.[0]?.[0]?.value).toBe('[\n  "a",\n  "b"\n]');
  });

  /* The daemon caps the result it echoes into a hint, so a long one arrives
     cut mid-payload with a marker. There is no structure left to lay out. */
  test("declines a truncated tail, so the caller shows it as it arrived", () => {
    expect(
      parseResultPayload('[{"confidence":"low"… [truncated 900 chars'),
    ).toBeNull();
  });

  test("declines a bare value, which has no field name to label it with", () => {
    expect(parseResultPayload('"just a string"')).toBeNull();
    expect(parseResultPayload("[1, 2, 3]")).toBeNull();
  });
});
