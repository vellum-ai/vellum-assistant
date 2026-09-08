import { describe, expect, test } from "bun:test";

import { WatchRetroSurfaceDataSchema } from "../api/surfaces.js";
import type { ToolContext } from "../tools/types.js";
import { executeWatchRetroReport } from "../tools/watch/watch-retro-report.js";

/**
 * The payload a dev-QA session produced: every question's text under
 * `question` instead of `prompt`, every option's under `value` instead of
 * `label`. Both are names the surface schema does not know, so it strips them
 * and the card draws two pages with nothing on them.
 */
const MISNAMED_FIELDS = {
  task: "Check Slack for unread messages between terminal work",
  steps: ["Work in the terminal", "Switch to Slack"],
  questions: [
    {
      id: "scope",
      kind: "pick",
      question: "Where does this routine end?",
      options: [
        { note: "This matches what the recording showed.", value: "Just read" },
        { value: "Also draft or send replies" },
      ],
    },
  ],
} as const;

/** The same report with the names the card actually reads. */
const WELL_FORMED = {
  task: "Check Slack for unread messages between terminal work",
  steps: ["Work in the terminal", "Switch to Slack"],
  questions: [
    {
      id: "scope",
      kind: "pick",
      prompt: "Where does this routine end?",
      options: [
        {
          id: "scope-read",
          label: "Just read",
          note: "This matches what the recording showed.",
        },
        { id: "scope-reply", label: "Also draft or send replies" },
      ],
    },
  ],
} as const;

const context = {} as ToolContext;

async function report(input: unknown): Promise<{
  content: string;
  isError: boolean | undefined;
}> {
  const result = await executeWatchRetroReport(
    input as Record<string, unknown>,
    context,
  );
  return { content: result.content, isError: result.isError };
}

describe("watch_retro_report validates the question shape", () => {
  test("a well-formed report is recorded", async () => {
    const result = await report(WELL_FORMED);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('"recorded":true');
  });

  // The failure this whole file exists for. The surface schema is tolerant by
  // design and will not complain, so the tool is the only layer that can tell
  // the model, while it still has a turn to spend, that the card it just
  // described has no text on it.
  test("a question whose text is under the wrong key is refused by field name", async () => {
    const result = await report(MISNAMED_FIELDS);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("questions.0.prompt");
  });

  test("an option whose label is under the wrong key is refused by field name", async () => {
    const result = await report({
      ...WELL_FORMED,
      questions: [
        {
          ...WELL_FORMED.questions[0],
          options: [
            { id: "a", value: "Just read" },
            { id: "b", value: "Also reply" },
          ],
        },
      ],
    });
    expect(result.isError).toBe(true);
    // Named as the missing field, not as the option count. An array whose
    // entries failed to parse looks empty, and "send more options" is the one
    // correction that cannot help here.
    expect(result.content).toContain("questions.0.options.0.label");
    expect(result.content).not.toContain("two to four options");
  });

  test("a pick with one option is refused, since the renderer drops it", async () => {
    const result = await report({
      ...WELL_FORMED,
      questions: [
        {
          ...WELL_FORMED.questions[0],
          options: [WELL_FORMED.questions[0].options[0]],
        },
      ],
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("two to four options");
  });

  test("a fill needs no options", async () => {
    const result = await report({
      ...WELL_FORMED,
      questions: [
        {
          id: "start-phrase",
          kind: "fill",
          prompt: "What would you say to kick this off?",
          suggestion: "check slack for unread",
        },
      ],
    });
    expect(result.isError).toBe(false);
  });

  // Two questions under one id is not a parse failure: the renderer keeps the
  // first and drops the rest, because the id is the key an answer comes back
  // under. The user loses a page and nothing says why.
  test("two questions sharing an id are refused", async () => {
    const result = await report({
      ...WELL_FORMED,
      questions: [WELL_FORMED.questions[0], { ...WELL_FORMED.questions[0] }],
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('id "scope"');
  });

  test("questions stay optional, since a settled recording asks nothing", async () => {
    const result = await report({ task: "Rename a column", steps: ["Rename"] });
    expect(result.isError).toBe(false);
  });
});

describe("WatchRetroSurfaceDataSchema on a missing required string", () => {
  // `z.coerce.string()` stringifies whatever it is handed, so an absent field
  // parsed as the literal "undefined" and rendered as that word on the card.
  // A blank is what the renderer's own filters are written against.
  test("an absent prompt and label are blank, not the word undefined", () => {
    const parsed = WatchRetroSurfaceDataSchema.parse(MISNAMED_FIELDS);
    const question = parsed.questions?.[0];

    expect(question?.prompt).toBe("");
    expect(question?.options?.[0]?.label).toBe("");
    expect(question?.options?.[0]?.id).toBe("");
  });

  test("an absent task is blank, so the card falls back rather than titling itself undefined", () => {
    expect(WatchRetroSurfaceDataSchema.parse({ steps: [] }).task).toBe("");
  });

  // The point of the blank: it is what `isAnswerable` in the renderer filters
  // an unusable question on. A card built from the misnamed payload shows its
  // record and no question pages, instead of pages the user cannot read.
  test("the fields the payload did name still survive", () => {
    const parsed = WatchRetroSurfaceDataSchema.parse(MISNAMED_FIELDS);

    expect(parsed.task).toBe(
      "Check Slack for unread messages between terminal work",
    );
    expect(parsed.questions?.[0]?.options?.[0]?.note).toBe(
      "This matches what the recording showed.",
    );
  });

  test("a well-formed payload is unchanged by the coercion", () => {
    const parsed = WatchRetroSurfaceDataSchema.parse(WELL_FORMED);

    expect(parsed.questions?.[0]?.prompt).toBe("Where does this routine end?");
    expect(parsed.questions?.[0]?.options?.[0]?.label).toBe("Just read");
  });
});
