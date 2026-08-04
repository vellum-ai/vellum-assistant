/** Tests for `resolvePreview`, the feed card's preview text resolver. */

import { describe, expect, test } from "bun:test";

import { resolvePreview } from "./feed-preview";

/** The daemon's `NOTIFICATION_TITLE_MAX_LENGTH`, the clamp `deriveTitle` uses. */
const DERIVED_TITLE_MAX_LENGTH = 60;

/** Build a title the way the daemon's `deriveTitle` builds an over-long one. */
function deriveTruncatedTitle(body: string, ellipsis: string): string {
  return body.slice(0, DERIVED_TITLE_MAX_LENGTH).trim() + ellipsis;
}

describe("resolvePreview", () => {
  test("unwraps inline emphasis in a flattened summary", () => {
    expect(
      resolvePreview(
        "Watcher job failed",
        "**Error:** message channel closed before a response was received.",
      ),
    ).toBe("Error: message channel closed before a response was received.");
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

  test("unwraps emphasis and code spans in the continuation", () => {
    expect(
      resolvePreview(
        "Deploy failed",
        "**Deploy failed** because the `api` worker never reported healthy.",
      ),
    ).toBe("because the api worker never reported healthy.");
  });

  test("drops a bold title's trailing period orphaned by the slice", () => {
    expect(
      resolvePreview(
        "Deploy failed",
        "**Deploy failed.** The api worker never reported healthy.",
      ),
    ).toBe("The api worker never reported healthy.");
  });

  test("drops an exclamation mark orphaned by the slice", () => {
    expect(
      resolvePreview(
        "Deploy failed!",
        "Deploy failed! The api worker never reported healthy.",
      ),
    ).toBe("The api worker never reported healthy.");
  });

  test("drops a question mark orphaned by the slice", () => {
    expect(
      resolvePreview(
        "Deploy failed?",
        "Deploy failed? The api worker never reported healthy.",
      ),
    ).toBe("The api worker never reported healthy.");
  });

  test("unwraps a code span that starts the continuation", () => {
    expect(
      resolvePreview("Deploy failed", "Deploy failed: `api` never came up."),
    ).toBe("api never came up.");
  });

  test("returns null when the summary only links the title text", () => {
    expect(
      resolvePreview("Read docs", "Read [docs](https://example.com)"),
    ).toBeNull();
  });

  test("returns the continuation after a linked title prefix", () => {
    expect(
      resolvePreview(
        "Read the docs",
        "Read the [docs](https://example.com) before rerunning the deploy.",
      ),
    ).toBe("before rerunning the deploy.");
  });

  test("keeps link text the title only partly covers", () => {
    expect(
      resolvePreview(
        "Read docs",
        "Read [docs and specs](https://example.com) before the next deploy.",
      ),
    ).toBe("and specs before the next deploy.");
  });

  test("unwraps a link the title does not cover", () => {
    expect(
      resolvePreview(
        "Nightly backup",
        "See [the report](https://example.com) for volume details.",
      ),
    ).toBe("See the report for volume details.");
  });

  test("unwraps a reference link to its text", () => {
    expect(
      resolvePreview(
        "Nightly backup",
        "See [the report][r] for volume details.\n\n[r]: https://example.com",
      ),
    ).toBe("See the report for volume details.");
  });

  test("does not strand a destination holding an escaped closing paren", () => {
    const preview = resolvePreview(
      "Read docs",
      "Read [docs](a\\)) before rerunning the deploy.",
    );
    expect(preview).toBe("before rerunning the deploy.");
    expect(preview?.startsWith(")")).toBe(false);
  });

  test("returns null when strikethrough wraps the whole title", () => {
    expect(resolvePreview("Deploy failed", "~~Deploy failed~~")).toBeNull();
  });

  test("returns the continuation after a struck-through title prefix", () => {
    expect(
      resolvePreview(
        "Deploy failed",
        "~~Deploy failed~~ because the api worker never reported healthy.",
      ),
    ).toBe("because the api worker never reported healthy.");
  });

  test("handles single-tilde strikethrough in the prefix", () => {
    expect(
      resolvePreview(
        "Deploy failed",
        "~Deploy failed~ and the pods stayed down.",
      ),
    ).toBe("and the pods stayed down.");
  });

  test("returns null when the continuation is too short", () => {
    expect(resolvePreview("Deploy failed", "Deploy failed on api.")).toBeNull();
  });

  test("strips headings and bullets and unwraps inline bold", () => {
    expect(
      resolvePreview(
        "Deploy report",
        "## Deploy failed\n\n- **api** timed out\n- worker OK",
      ),
    ).toBe("Deploy failed api timed out worker OK");
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

  test("drops a fenced code block nested in a blockquote", () => {
    expect(
      resolvePreview(
        "Build log",
        "Head of the log:\n\n> ```\n> secret payload\n> ```\n\nRerun the job.",
      ),
    ).toBe("Head of the log: Rerun the job.");
  });

  test("closes a blockquoted fence whose marker carries no space", () => {
    const preview = resolvePreview(
      "Build log",
      "Head:\n> ```\n> payload\n>```\nAfter",
    );
    expect(preview).toBe("Head: After");
    expect(preview).not.toContain("payload");
  });

  test("drops a fenced code block nested in a list item", () => {
    expect(
      resolvePreview(
        "Runbook",
        "Do this first:\n\n- ```\n  vellum run\n  ```\n\nThen check the log.",
      ),
    ).toBe("Do this first: Then check the log.");
  });

  test("does not close a top-level fence on a bulleted fence line of code", () => {
    const preview = resolvePreview(
      "Build log",
      "Head:\n```text\n- ```\nsecret payload\n```",
    );
    expect(preview).toBe("Head:");
    expect(preview).not.toContain("secret payload");
  });

  test("does not close a list-nested fence on a bulleted fence line of code", () => {
    const preview = resolvePreview(
      "Runbook",
      "Do this first:\n\n- ```text\n  - ```\n  secret payload\n  ```\n\nThen check the log.",
    );
    expect(preview).toBe("Do this first: Then check the log.");
    expect(preview).not.toContain("secret payload");
  });

  test("treats a backtick run with a backticked info string as an inline span", () => {
    expect(
      resolvePreview("Status check", "```code``` is the reported value"),
    ).toBe("code is the reported value");
  });

  test("unwraps a code span whose content holds a backtick", () => {
    const preview = resolvePreview(
      "Shell tip",
      "Use ``a ` b`` in the shell without escaping.",
    );
    expect(preview).toBe("Use a ` b in the shell without escaping.");
  });

  test("keeps escaped asterisks as literal text", () => {
    expect(
      resolvePreview(
        "Export formatting",
        "The label reads \\* literal stars \\* exactly as typed.",
      ),
    ).toBe("The label reads * literal stars * exactly as typed.");
    expect(
      resolvePreview(
        "Export formatting",
        "The label reads \\*literal stars\\* exactly as typed.",
      ),
    ).toBe("The label reads *literal stars* exactly as typed.");
  });

  test("returns a markdown-rich summary as plain text", () => {
    const preview = resolvePreview(
      "Release notes",
      "## Rollout\n\n- **api** is `healthy` after the [runbook](https://example.com) steps\n- *worker* recovered",
    );
    expect(preview).toBe(
      "Rollout api is healthy after the runbook steps worker recovered",
    );
    for (const character of ["*", "`", "#", "[", "]"]) {
      expect(preview).not.toContain(character);
    }
  });

  test("still opens a tilde fence whose info string holds a backtick", () => {
    expect(
      resolvePreview(
        "Build log",
        "Two files changed.\n~~~`js`\ndiff --git a b\n~~~\nRerun when ready.",
      ),
    ).toBe("Two files changed. Rerun when ready.");
  });

  test("keeps a fenced line with trailing text inside the block", () => {
    expect(
      resolvePreview(
        "Build log",
        "Compilation stopped early:\n```ts\n```not-a-close\nconst secret = 1;\n```\n\nSee the job output.",
      ),
    ).toBe("Compilation stopped early: See the job output.");
  });

  test("closes a fenced code block on a fence with trailing spaces", () => {
    expect(
      resolvePreview(
        "Build log",
        "Head of the log:\n```\nstack trace\n```   \nRerun the job.",
      ),
    ).toBe("Head of the log: Rerun the job.");
  });

  test("drops an unterminated fenced code block", () => {
    expect(
      resolvePreview("Build log", "Head of the log:\n```\nstack trace here"),
    ).toBe("Head of the log:");
  });

  test("drops an unterminated block holding a fence-like line", () => {
    expect(
      resolvePreview(
        "Build log",
        "Head of the log:\n```\n```not-a-close\nstack trace here",
      ),
    ).toBe("Head of the log:");
  });

  test("flattens a GFM table to its cell text", () => {
    const preview = resolvePreview(
      "Table",
      "| Job | State |\n| --- | :---: |\n| api | failed |",
    );
    expect(preview).toBe("Job State api failed");
    expect(preview).not.toContain("---");
  });

  test("drops thematic breaks written with asterisks", () => {
    const preview = resolvePreview("Rollout notes", "Before\n\n***\n\nAfter");
    expect(preview).toBe("Before After");
    expect(preview).not.toContain("***");
  });

  test("drops thematic breaks written with underscores", () => {
    const preview = resolvePreview("Rollout notes", "Before\n\n___\n\nAfter");
    expect(preview).toBe("Before After");
    expect(preview).not.toContain("___");
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
    const preview = resolvePreview("Deploy", "Deployment queue is backed up");
    expect(preview).toBe("Deployment queue is backed up");
    expect(preview).not.toBe("ment queue is backed up");
  });

  test("matches a derived title clamped with a horizontal ellipsis", () => {
    const summary =
      "Deploy failed because the api worker never reported healthy after three restarts.";
    const title = deriveTruncatedTitle(summary, "…");
    // The first sentence runs past the clamp, which is what appends the ellipsis.
    expect(summary.length).toBeGreaterThan(DERIVED_TITLE_MAX_LENGTH);

    const preview = resolvePreview(title, summary);
    expect(preview).toBe("after three restarts.");
    expect(preview).not.toContain("Deploy failed");
    expect(preview).not.toContain("api worker");
  });

  test("matches a derived title clamped with three periods", () => {
    const summary =
      "Deploy failed because the api worker never reported healthy after three restarts.";
    const title = deriveTruncatedTitle(summary, "...");

    const preview = resolvePreview(title, summary);
    expect(preview).toBe("after three restarts.");
    expect(preview).not.toContain("Deploy failed");
  });

  test("keeps the straddled word whole when the clamp cuts mid-word", () => {
    const summary =
      "Deploy failed because the api worker never reported unhealthy after restarts.";
    const title = deriveTruncatedTitle(summary, "…");
    // The clamp lands inside "unhealthy", which is what the marker signals.
    expect(title).toBe(
      "Deploy failed because the api worker never reported unhealth…",
    );

    const preview = resolvePreview(title, summary);
    expect(preview).toBe("unhealthy after restarts.");
    expect(preview?.startsWith("y ")).toBe(false);
  });

  test("keeps the straddled word whole for a three-period clamp", () => {
    const summary =
      "Deploy failed because the api worker never reported unhealthy after restarts.";
    const title = deriveTruncatedTitle(summary, "...");

    const preview = resolvePreview(title, summary);
    expect(preview).toBe("unhealthy after restarts.");
    expect(preview?.startsWith("y ")).toBe(false);
  });

  test("keeps the whole preview when an ellipsized title is not a prefix", () => {
    const summary =
      "The api worker never reported healthy after three restarts.";
    expect(resolvePreview("Waiting on the deploy…", summary)).toBe(summary);
    expect(resolvePreview("Waiting on the deploy...", summary)).toBe(summary);
  });

  test("does not split a decomposed letter away from its combining mark", () => {
    const combiningAcute = "\u0301";
    const summary = `Cafe${combiningAcute} outage affected the api worker`;
    expect(summary).toBe(summary.normalize("NFD"));

    const preview = resolvePreview("Cafe", summary);
    expect(preview).toBe(summary);
    expect(preview?.startsWith(combiningAcute)).toBe(false);
  });
});
