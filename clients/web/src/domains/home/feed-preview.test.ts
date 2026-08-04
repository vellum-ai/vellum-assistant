/** Tests for `resolvePreview`, the feed card's preview text resolver. */

import { describe, expect, test } from "bun:test";

import { resolvePreview } from "./feed-preview";

describe("resolvePreview", () => {
  test("keeps inline emphasis in a flattened summary", () => {
    expect(
      resolvePreview(
        "Watcher job failed",
        "**Error:** message channel closed before a response was received.",
      ),
    ).toBe("**Error:** message channel closed before a response was received.");
  });

  test("passes a genuinely distinct summary through untouched", () => {
    expect(
      resolvePreview("Nightly backup", "All three volumes verified."),
    ).toBe("All three volumes verified.");
  });

  test("returns null when the title and the summary are identical", () => {
    const text = "Deploy finished without incident";
    expect(resolvePreview(text, text)).toBeNull();
  });

  test("ignores emphasis and trailing punctuation when matching", () => {
    expect(resolvePreview("Deploy failed", "**Deploy failed.**")).toBeNull();
  });

  test("returns the continuation when the title is a prefix of the summary", () => {
    const preview = resolvePreview(
      "Deploy failed",
      "Deploy failed because the api worker never reported healthy.",
    );
    expect(preview).toBe("because the api worker never reported healthy.");
  });

  test("keeps emphasis intact in the continuation", () => {
    expect(
      resolvePreview(
        "Deploy failed",
        "**Deploy failed** because the `api` worker never reported healthy.",
      ),
    ).toBe("because the `api` worker never reported healthy.");
  });

  test("drops a closing emphasis marker orphaned by the slice", () => {
    expect(
      resolvePreview(
        "Deploy failed",
        "**Deploy failed.** The api worker never reported healthy.",
      ),
    ).toBe("The api worker never reported healthy.");
  });

  test("keeps a code span that starts the continuation", () => {
    expect(
      resolvePreview("Deploy failed", "Deploy failed: `api` never came up."),
    ).toBe("`api` never came up.");
  });

  test("returns null when the continuation is too short", () => {
    expect(resolvePreview("Deploy failed", "Deploy failed on api.")).toBeNull();
  });

  test("strips headings and bullets while preserving inline bold", () => {
    expect(
      resolvePreview(
        "Deploy report",
        "## Deploy failed\n\n- **api** timed out\n- worker OK",
      ),
    ).toBe("Deploy failed **api** timed out worker OK");
  });

  test("strips ordered list markers in both delimiter forms", () => {
    expect(
      resolvePreview("Steps", "1. Pull the image\n2) Restart the pod"),
    ).toBe("Pull the image Restart the pod");
  });

  test("strips blockquote markers, including nested bullets", () => {
    expect(
      resolvePreview("Quoted", "> The check timed out\n> - retry scheduled"),
    ).toBe("The check timed out retry scheduled");
  });

  test("drops fenced code block contents", () => {
    const preview = resolvePreview(
      "Build log",
      "Compilation stopped early:\n\n```ts\nconst secret = 1;\n```\n\nSee the job output.",
    );
    expect(preview).toBe("Compilation stopped early: See the job output.");
  });

  test("drops tilde fenced code block contents", () => {
    expect(
      resolvePreview(
        "Build log",
        "Two files changed.\n~~~\ndiff --git a b\n~~~\nRerun when ready.",
      ),
    ).toBe("Two files changed. Rerun when ready.");
  });

  test("drops an unterminated fenced code block", () => {
    expect(
      resolvePreview("Build log", "Head of the log:\n```\nstack trace here"),
    ).toBe("Head of the log:");
  });

  test("drops GFM table delimiter rows", () => {
    expect(
      resolvePreview(
        "Table",
        "| Job | State |\n| --- | :---: |\n| api | failed |",
      ),
    ).toBe("| Job | State | | api | failed |");
  });

  test("handles CRLF line endings", () => {
    expect(
      resolvePreview("Report", "## Deploy failed\r\n\r\n- api timed out"),
    ).toBe("Deploy failed api timed out");
  });

  test("returns null for a whitespace-only summary", () => {
    expect(resolvePreview("Anything", "   \n\t\r\n  ")).toBeNull();
  });

  test("returns null for an empty summary", () => {
    expect(resolvePreview("Anything", "")).toBeNull();
  });

  test("returns null when the summary is only a fenced code block", () => {
    expect(resolvePreview("Snippet", "```\nconst a = 1;\n```")).toBeNull();
  });

  test("does not treat a shared word prefix as a derived title", () => {
    expect(resolvePreview("Deploy", "Deployment queue is backed up")).toBe(
      "Deployment queue is backed up",
    );
  });
});
