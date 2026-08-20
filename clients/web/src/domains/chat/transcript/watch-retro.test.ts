/**
 * Tests for `parseWatchRetro`, the recognition step behind the watch
 * retrospective's in-chat presentation.
 *
 * The text it reads is written by a model against a prompt that names four
 * things to report and no headings to report them under, so the tests are
 * organized around the two properties that have to hold whatever the wording
 * turns out to be: recognition fails silently and completely when the shape is
 * not there, and no line of a message that IS recognized is ever dropped.
 */

import { describe, expect, test } from "bun:test";

import {
  parseWatchRetro,
  type WatchRetroPointsSegment,
} from "@/domains/chat/transcript/watch-retro";

/** A retrospective in the shape a real session produced. */
const RETRO = [
  "## 1. The task",
  "",
  "You were cleaning up your **Downloads** folder by removing disk image files.",
  "",
  "## 2. The phrase you would use to ask me to do this",
  "",
  '> "I have some DMGs in Downloads that I don\'t need anymore."',
  "",
  "## 3. Steps",
  "",
  "1. Open Finder.",
  "2. Select **Downloads** from the sidebar.",
  "",
  "## 4. What I'm unsure about",
  "",
  "- Which specific DMG files are safe to remove.",
  "- Whether Finder should open directly to Downloads every time.",
  "",
  "### Alignment pass",
  "",
  "Before I author the skill, please confirm or correct these points:",
  "",
  "1. **Task:** Should the skill move approved `.dmg` files to Trash?",
  "2. **Trigger phrases:** Are these the words you would use?",
].join("\n");

function pointsOf(
  markdown: string,
  kind: "gaps" | "alignment",
): WatchRetroPointsSegment {
  const segments = parseWatchRetro(markdown);
  expect(segments).not.toBeNull();
  const found = segments?.find(
    (segment): segment is WatchRetroPointsSegment => segment.kind === kind,
  );
  expect(found).toBeDefined();
  if (!found) {
    throw new Error(`no ${kind} segment`);
  }
  return found;
}

/**
 * A line reduced to its content, so a heading that survived as markdown and a
 * heading that was lifted into a segment compare equal.
 */
function content(line: string): string {
  return line
    .replace(/^\s*#{1,6}\s+/, "")
    .replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+/, "")
    .trim();
}

/** Every line the segments would render, back in message order. */
function renderedLines(markdown: string): string[] {
  const segments = parseWatchRetro(markdown);
  if (!segments) {
    return [];
  }
  const out: string[] = [];
  for (const segment of segments) {
    if (segment.kind === "markdown") {
      out.push(...segment.text.split("\n"));
      continue;
    }
    out.push(segment.heading);
    out.push(...segment.lead.split("\n"));
    out.push(...segment.points);
  }
  return out.map(content).filter((line) => line.length > 0);
}

describe("parseWatchRetro — recognition", () => {
  test("recognizes both answerable sections of a real retrospective", () => {
    const gaps = pointsOf(RETRO, "gaps");
    const alignment = pointsOf(RETRO, "alignment");

    expect(gaps.heading).toBe("What I'm unsure about");
    expect(gaps.points).toEqual([
      "Which specific DMG files are safe to remove.",
      "Whether Finder should open directly to Downloads every time.",
    ]);
    expect(alignment.heading).toBe("Alignment pass");
    expect(alignment.points).toEqual([
      "**Task:** Should the skill move approved `.dmg` files to Trash?",
      "**Trigger phrases:** Are these the words you would use?",
    ]);
    expect(alignment.lead).toBe(
      "Before I author the skill, please confirm or correct these points:",
    );
  });

  test("keeps the model's own heading wording rather than a fixed label", () => {
    const reworded = RETRO.replace(
      "## 4. What I'm unsure about",
      "## Things I could not tell from watching",
    ).replace("### Alignment pass", "### Confirm before I build");

    expect(pointsOf(reworded, "gaps").heading).toBe(
      "Things I could not tell from watching",
    );
    expect(pointsOf(reworded, "alignment").heading).toBe(
      "Confirm before I build",
    );
  });

  test("folds a wrapped bullet's continuation line into one point", () => {
    const wrapped = RETRO.replace(
      "- Which specific DMG files are safe to remove.",
      "- Which specific DMG files\n  are safe to remove.",
    );

    expect(pointsOf(wrapped, "gaps").points[0]).toBe(
      "Which specific DMG files are safe to remove.",
    );
  });
});

describe("parseWatchRetro — falling back to plain markdown", () => {
  test("returns null for an ordinary assistant message", () => {
    expect(parseWatchRetro("Sure, here is the file you asked for.")).toBeNull();
  });

  test("returns null when only the uncertainty section is present", () => {
    const withoutAlignment = RETRO.slice(
      0,
      RETRO.indexOf("### Alignment pass"),
    );

    expect(parseWatchRetro(withoutAlignment)).toBeNull();
  });

  test("returns null when only the alignment section is present", () => {
    const withoutGaps = RETRO.replace(
      "## 4. What I'm unsure about",
      "## 4. Notes",
    );

    expect(parseWatchRetro(withoutGaps)).toBeNull();
  });

  test("returns null when a recognized heading has no points under it", () => {
    const prose = RETRO.replace(
      [
        "- Which specific DMG files are safe to remove.",
        "- Whether Finder should open directly to Downloads every time.",
      ].join("\n"),
      "I could not tell which files were safe to remove.",
    );

    expect(parseWatchRetro(prose)).toBeNull();
  });

  test("ignores a heading that only appears inside a fenced code block", () => {
    const fenced = [
      "Here is the script I ran:",
      "",
      "```sh",
      "# What I'm unsure about",
      "- nothing",
      "# Alignment pass",
      "- nothing",
      "```",
    ].join("\n");

    expect(parseWatchRetro(fenced)).toBeNull();
  });
});

describe("parseWatchRetro — nothing is dropped", () => {
  test("returns every non-blank line of the message", () => {
    const expected = RETRO.split("\n")
      .map(content)
      .filter((line) => line.length > 0);

    expect(renderedLines(RETRO)).toEqual(expected);
  });

  test("keeps a section the parser does not recognize, in place", () => {
    const extra = `${RETRO}\n\n## 5. What happens next\n\nI will scaffold the skill once you confirm.`;
    const segments = parseWatchRetro(extra);

    expect(segments?.at(-1)).toEqual({
      kind: "markdown",
      text: "## 5. What happens next\n\nI will scaffold the skill once you confirm.",
    });
  });

  test("keeps prose written after a recognized section's list", () => {
    const trailing = RETRO.replace(
      "2. **Trigger phrases:** Are these the words you would use?",
      "2. **Trigger phrases:** Are these the words you would use?\n\nTell me if any of this is wrong.",
    );
    const segments = parseWatchRetro(trailing);

    expect(segments?.at(-1)).toEqual({
      kind: "markdown",
      text: "Tell me if any of this is wrong.",
    });
  });
});
