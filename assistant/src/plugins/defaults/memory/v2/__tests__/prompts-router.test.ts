/**
 * Tests for `assistant/src/memory/v2/prompts/router.ts` —
 * `renderRouterPrompt` (placeholder substitution in the bundled body) and
 * `resolveRouterPrompt` (file-override path with fallback).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { renderRouterPrompt, resolveRouterPrompt } from "../prompts/router.js";

const SAMPLE_INDEX = `[1] morning-routine — coffee, walk, journal (edges: 2)
[2] journal-style — terse, dated, no fluff (edges: 1)
[3] taxes-2025 — Q1 estimate due April 15 (edges: )`;

describe("renderRouterPrompt — substitution", () => {
  test("replaces all three placeholders with the supplied values", () => {
    const out = renderRouterPrompt({
      assistantName: "Aria",
      userName: "Alice",
      pageIndexBlock: SAMPLE_INDEX,
    });

    expect(out).not.toContain("{{ASSISTANT_NAME}}");
    expect(out).not.toContain("{{USER_NAME}}");
    expect(out).not.toContain("{{PAGE_INDEX}}");
    expect(out).toContain("Aria");
    expect(out).toContain("Alice");
    expect(out).toContain(SAMPLE_INDEX);
  });

  test("substitutes every occurrence of the assistant name placeholder", () => {
    const out = renderRouterPrompt({
      assistantName: "Aria",
      userName: "Alice",
      pageIndexBlock: SAMPLE_INDEX,
    });

    // Body references the assistant name in multiple sentences; ensure none
    // of them leak the raw placeholder.
    const matches = out.match(/Aria/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});

describe("renderRouterPrompt — neutral fallbacks", () => {
  test("falls back to 'the assistant' when assistantName is null", () => {
    const out = renderRouterPrompt({
      assistantName: null,
      userName: "Alice",
      pageIndexBlock: SAMPLE_INDEX,
    });

    expect(out).toContain("the assistant");
    expect(out).not.toContain("{{ASSISTANT_NAME}}");
  });

  test("falls back to 'the user' when userName is null", () => {
    const out = renderRouterPrompt({
      assistantName: "Aria",
      userName: null,
      pageIndexBlock: SAMPLE_INDEX,
    });

    expect(out).toContain("the user");
    expect(out).not.toContain("{{USER_NAME}}");
  });

  test("uses both fallbacks when both names are null", () => {
    const out = renderRouterPrompt({
      assistantName: null,
      userName: null,
      pageIndexBlock: SAMPLE_INDEX,
    });

    expect(out).toContain("the assistant");
    expect(out).toContain("the user");
  });

  test("falls back when names are whitespace-only strings", () => {
    const out = renderRouterPrompt({
      assistantName: "   ",
      userName: "\t\n",
      pageIndexBlock: SAMPLE_INDEX,
    });

    expect(out).toContain("the assistant");
    expect(out).toContain("the user");
  });
});

describe("renderRouterPrompt — page index handling", () => {
  test("substitutes an empty pageIndexBlock cleanly without double-newline artifacts", () => {
    const out = renderRouterPrompt({
      assistantName: "Aria",
      userName: "Alice",
      pageIndexBlock: "",
    });

    expect(out).not.toContain("{{PAGE_INDEX}}");
    // The header should still be present and not followed by a stray
    // triple-newline run from collapsing the empty block.
    expect(out).toContain("# Concept Page Index");
    expect(out).not.toMatch(/\n\n\n/);
    // Output should end at the header section without trailing whitespace.
    expect(out.endsWith("# Concept Page Index\n\n")).toBe(true);
  });

  test("preserves the page index body verbatim, including edges syntax", () => {
    const out = renderRouterPrompt({
      assistantName: "Aria",
      userName: "Alice",
      pageIndexBlock: SAMPLE_INDEX,
    });

    expect(out).toContain(
      "[1] morning-routine — coffee, walk, journal (edges: 2)",
    );
    expect(out).toContain(
      "[3] taxes-2025 — Q1 estimate due April 15 (edges: )",
    );
  });
});

describe("renderRouterPrompt — replacement-pattern specials", () => {
  // String.prototype.replaceAll interprets `$&`, `$'`, `` $` ``, `$$`, and
  // `$n` in the replacement string as backreferences. LLM-generated page
  // index content can contain literal `$` runs, so the substituter must
  // pass values through unchanged.
  const SPECIALS = "$& and $' and $` and $$ and $1";

  test.each([
    [
      "pageIndexBlock",
      { assistantName: "Aria", userName: "Alice", pageIndexBlock: SPECIALS },
    ],
    [
      "assistantName",
      {
        assistantName: SPECIALS,
        userName: "Alice",
        pageIndexBlock: SAMPLE_INDEX,
      },
    ],
    [
      "userName",
      {
        assistantName: "Aria",
        userName: SPECIALS,
        pageIndexBlock: SAMPLE_INDEX,
      },
    ],
  ])("renders %s with $ specials verbatim", (_, opts) => {
    expect(renderRouterPrompt(opts)).toContain(SPECIALS);
  });
});

describe("renderRouterPrompt — determinism & snapshot stability", () => {
  test("returns the same string for the same inputs", () => {
    const opts = {
      assistantName: "Aria",
      userName: "Alice",
      pageIndexBlock: SAMPLE_INDEX,
    };
    expect(renderRouterPrompt(opts)).toBe(renderRouterPrompt(opts));
  });

  test("snapshot of fixed inputs", () => {
    const out = renderRouterPrompt({
      assistantName: "Aria",
      userName: "Alice",
      pageIndexBlock: SAMPLE_INDEX,
    });

    expect(out).toMatchSnapshot();
  });
});

describe("renderRouterPrompt — content expectations", () => {
  test("references the select_pages_to_inject tool name", () => {
    const out = renderRouterPrompt({
      assistantName: "Aria",
      userName: "Alice",
      pageIndexBlock: SAMPLE_INDEX,
    });

    expect(out).toContain("select_pages_to_inject");
  });

  test("describes the already_injected_ids and now markers", () => {
    const out = renderRouterPrompt({
      assistantName: "Aria",
      userName: "Alice",
      pageIndexBlock: SAMPLE_INDEX,
    });

    expect(out).toContain("<already_injected_ids>");
    expect(out).toContain("<now>");
  });

  test("biases toward inclusion when in doubt", () => {
    const out = renderRouterPrompt({
      assistantName: "Aria",
      userName: "Alice",
      pageIndexBlock: SAMPLE_INDEX,
    });

    expect(out.toLowerCase()).toContain("lean toward inclusion");
    expect(out.toLowerCase()).toContain("missing a relevant page");
  });
});

describe("resolveRouterPrompt — override path", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vellum-router-prompt-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const STD_OPTS = {
    assistantName: "Aria",
    userName: "Alice",
    pageIndexBlock: SAMPLE_INDEX,
  };

  test("null overridePath returns the bundled prompt verbatim", () => {
    expect(resolveRouterPrompt(null, tmpDir, STD_OPTS)).toEqual(
      renderRouterPrompt(STD_OPTS),
    );
  });

  test("loads override and substitutes placeholders", () => {
    const overridePath = join(tmpDir, "router.md");
    writeFileSync(
      overridePath,
      "Hi {{ASSISTANT_NAME}}, you are routing for {{USER_NAME}}.\n\n{{PAGE_INDEX}}",
      "utf-8",
    );

    const out = resolveRouterPrompt(overridePath, tmpDir, STD_OPTS);
    expect(out).toContain("Hi Aria, you are routing for Alice.");
    expect(out).toContain(SAMPLE_INDEX);
    expect(out).not.toContain("{{ASSISTANT_NAME}}");
    expect(out).not.toContain("{{PAGE_INDEX}}");
  });

  test("relative override path is resolved under the passed workspaceDir, not the default workspace", () => {
    // Write the override into the per-test temp dir, which acts as a
    // non-default workspace. The configured path is purely relative so the
    // loader must resolve it against the supplied workspaceDir — if it
    // resolved against the process-wide default workspace instead, the file
    // wouldn't be found and the bundled prompt would be returned.
    const relativeName = "router-override.md";
    writeFileSync(
      join(tmpDir, relativeName),
      "Routed via {{ASSISTANT_NAME}} for {{USER_NAME}} :: {{PAGE_INDEX}}",
      "utf-8",
    );

    const out = resolveRouterPrompt(relativeName, tmpDir, STD_OPTS);
    expect(out).toContain("Routed via Aria for Alice");
    expect(out).toContain(SAMPLE_INDEX);
    expect(out).not.toEqual(renderRouterPrompt(STD_OPTS));
  });

  test("missing override file falls back to bundled prompt", () => {
    const overridePath = join(tmpDir, "does-not-exist.md");
    expect(resolveRouterPrompt(overridePath, tmpDir, STD_OPTS)).toEqual(
      renderRouterPrompt(STD_OPTS),
    );
  });

  test("empty override file falls back to bundled prompt", () => {
    const overridePath = join(tmpDir, "empty.md");
    writeFileSync(overridePath, "   \n\t\n", "utf-8");
    expect(resolveRouterPrompt(overridePath, tmpDir, STD_OPTS)).toEqual(
      renderRouterPrompt(STD_OPTS),
    );
  });

  test("override that is a directory falls back to bundled prompt", () => {
    // Pass the temp directory itself as the override path — lstat sees a
    // directory, not a regular file, so the loader bails to bundled.
    expect(resolveRouterPrompt(tmpDir, tmpDir, STD_OPTS)).toEqual(
      renderRouterPrompt(STD_OPTS),
    );
  });

  test("override applies neutral fallbacks for missing names", () => {
    const overridePath = join(tmpDir, "neutral.md");
    writeFileSync(
      overridePath,
      "Hi {{ASSISTANT_NAME}}, routing for {{USER_NAME}}.",
      "utf-8",
    );

    const out = resolveRouterPrompt(overridePath, tmpDir, {
      assistantName: null,
      userName: null,
      pageIndexBlock: "",
    });
    expect(out).toBe("Hi the assistant, routing for the user.");
  });
});
