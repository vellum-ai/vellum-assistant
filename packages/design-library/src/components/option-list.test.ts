/**
 * What a query leaves of a list, which is the part both shells around
 * `OptionListRows` depend on and neither can assert for itself: the popover
 * shell and the inline shell render the same layout, so it is tested once,
 * here, on the function that produces it.
 */

import { describe, expect, test } from "bun:test";

import { optionListLayout, type OptionListItem } from "./option-list";

const options: OptionListItem[] = [
  { value: "opus-5", label: "Claude Opus 5", group: "Anthropic" },
  { value: "sonnet-5", label: "Claude Sonnet 5", group: "Anthropic" },
  { value: "opus-4-8", label: "Claude Opus 4.8", group: "Anthropic", folded: true },
  { value: "haiku-4-5", label: "Claude Haiku 4.5", group: "Anthropic", folded: true },
  { value: "see-more", label: "See more", group: "Anthropic", listAction: true },
  { value: "gpt-5-6", label: "GPT-5.6", group: "OpenAI" },
  { value: "custom", label: "Enter a custom model ID…", sticky: true },
];

function labelsOf(layout: ReturnType<typeof optionListLayout>): string[] {
  return layout.sections.flatMap((section) =>
    section.rows.map((row) => row.label),
  );
}

describe("optionListLayout", () => {
  test("browsing offers the unfolded rows and the row that unfolds the rest", () => {
    const layout = optionListLayout(options, "", "");

    expect(layout.searching).toBe(false);
    expect(labelsOf(layout)).toEqual([
      "Claude Opus 5",
      "Claude Sonnet 5",
      "See more",
      "GPT-5.6",
    ]);
    expect(layout.stickyRows.map((row) => row.label)).toEqual([
      "Enter a custom model ID…",
    ]);
    // The pinned row is walkable but is not a match, so it is not counted.
    expect(layout.matches).toHaveLength(4);
    expect(layout.walkableValues).toEqual([
      "opus-5",
      "sonnet-5",
      "see-more",
      "gpt-5-6",
      "custom",
    ]);
  });

  test("a query reaches a folded row and drops the row that stood in for it", () => {
    const layout = optionListLayout(options, "  Opus 4.8 ", "");

    expect(layout.searching).toBe(true);
    expect(labelsOf(layout)).toEqual(["Claude Opus 4.8"]);
  });

  test("sections keep the order their first surviving row appears in", () => {
    const layout = optionListLayout(options, "gpt", "");

    expect(layout.sections.map((section) => section.group)).toEqual(["OpenAI"]);
  });

  test("shows the row it is set to from behind a fold, and only that one", () => {
    const layout = optionListLayout(options, "", "opus-4-8");

    // The answer is on the list whichever side of the fold it fell on, and
    // the section still has something left to disclose.
    expect(labelsOf(layout)).toEqual([
      "Claude Opus 5",
      "Claude Sonnet 5",
      "Claude Opus 4.8",
      "See more",
      "GPT-5.6",
    ]);
  });

  test("matches on the value as well as the label", () => {
    const layout = optionListLayout(options, "haiku-4", "");

    expect(labelsOf(layout)).toEqual(["Claude Haiku 4.5"]);
  });
});
