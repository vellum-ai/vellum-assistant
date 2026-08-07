import { describe, expect, test } from "bun:test";

import {
  describeMedia,
  mediaEmbeds,
  stripMarkdownForPreview,
} from "../notification-utils.js";

/**
 * The producer collapses whitespace after flattening, so most assertions read
 * the flattened text the way a lock screen would.
 */
function preview(value: string): string {
  return stripMarkdownForPreview(value).replace(/\s+/g, " ").trim();
}

describe("stripMarkdownForPreview", () => {
  describe("media embeds", () => {
    test("drops an embed whole, alt text included", () => {
      expect(
        preview("![vellum scene](vellum://workspace/clients/vellum-cut.mp4)"),
      ).toBe("");
    });

    test("reduces an embed-only reply to empty so the fallback is reachable", () => {
      const reply = [
        "![vellum scene](vellum://workspace/clients/web/public/cut.mp4)",
        "![hero animation](vellum://workspace/repos/hero.mp4)",
      ].join(" ");
      expect(preview(reply)).toBe("");
    });

    test("keeps the surrounding prose", () => {
      expect(
        preview("Here is the scene: ![vellum scene](vellum://workspace/a.mp4)"),
      ).toBe("Here is the scene:");
    });

    test("leaves no stray bang behind", () => {
      expect(preview("![alt](vellum://workspace/a.png)")).not.toContain("!");
    });

    // An embed needs no surrounding whitespace, so dropping it outright would
    // fuse the prose on either side into one word.
    test("separates the prose an inline embed sat between", () => {
      expect(preview("before![chart](https://example.com/a.png)after")).toBe(
        "before after",
      );
    });

    test("unwraps a plain link to its text", () => {
      expect(preview("See [report.pdf](vellum://workspace/report.pdf)")).toBe(
        "See report.pdf",
      );
    });
  });

  // Fenced content is code, not prose. Flattening it would rewrite the very
  // thing being previewed.
  describe("fenced code", () => {
    test("drops fence lines and keeps the fenced code", () => {
      expect(preview("Fixed it:\n```ts\nconst a = 1;\n```")).toBe(
        "Fixed it: const a = 1;",
      );
    });

    test("leaves a comment inside a fence with its hash", () => {
      expect(preview("Run:\n```sh\n# build first\nmake\n```")).toBe(
        "Run: # build first make",
      );
    });

    test("leaves a rule and a piped expression inside a fence alone", () => {
      expect(preview("```sh\n---\n| a | b |\n```")).toBe("--- | a | b |");
    });

    test("still flattens prose after the closing fence", () => {
      expect(preview("```\ncode\n```\n## After")).toBe("code After");
    });
  });

  describe("block markers", () => {
    test("drops heading markers", () => {
      expect(preview("## Summary\nAll green.")).toBe("Summary All green.");
    });

    test("drops blockquote markers", () => {
      expect(preview("> quoted line")).toBe("quoted line");
    });

    test("drops unordered and ordered list markers", () => {
      expect(preview("- one\n- two")).toBe("one two");
      expect(preview("1. first\n2) second")).toBe("first second");
    });

    test("drops horizontal rules", () => {
      expect(preview("before\n---\nafter")).toBe("before after");
    });
  });

  describe("tables", () => {
    test("unwraps cells and drops the delimiter row", () => {
      const table = "| Env | Key |\n|---|---|\n| dev | 4Y4L |";
      expect(preview(table)).toBe("Env Key dev 4Y4L");
    });

    test("leaves a pipe in prose alone", () => {
      expect(preview("run ls | grep foo")).toBe("run ls | grep foo");
    });
  });

  // Cases a hand-rolled marker scanner gets wrong and the parser gets right.
  describe("syntax that needs a real parser", () => {
    test("reads a destination whose URL has balanced parentheses", () => {
      expect(preview("![chart](https://cdn.example.com/a_(1).png)")).toBe("");
    });

    test("closes a fence only on its own delimiter", () => {
      expect(preview("```js\n~~~\nconst a = 1;\n~~~\n```")).toBe(
        "~~~ const a = 1; ~~~",
      );
    });

    test("flattens a GFM table that omits its outer pipes", () => {
      expect(preview("Env | Key\n--- | ---\ndev | 4Y4L")).toBe(
        "Env Key dev 4Y4L",
      );
    });

    test("keeps embed syntax quoted inside a code span", () => {
      expect(preview("Use `![alt](https://example.com/a.png)` here")).toBe(
        "Use ![alt](https://example.com/a.png) here",
      );
    });

    test("keeps escaped embed syntax", () => {
      expect(preview("\\![alt](https://example.com/a.png)")).toContain("alt");
    });
  });

  // The in-app renderer registers no `rehype-raw`, so raw HTML displays as
  // nothing there. The preview matches rather than showing markup the reader
  // never saw.
  describe("raw HTML", () => {
    test("keeps the text between a tag pair and drops the tags", () => {
      expect(preview("<strong>done</strong>")).toBe("done");
    });

    test("drops an HTML comment rather than leaking its contents", () => {
      expect(preview("<!-- internal note -->")).toBe("");
    });

    test("keeps the prose around a dropped tag", () => {
      expect(preview("All <em>green</em> now")).toBe("All green now");
    });
  });

  describe("what it must not touch", () => {
    test("passes plain prose through unchanged", () => {
      const prose = "Done. The deploy finished and the tests are green.";
      expect(stripMarkdownForPreview(prose)).toBe(prose);
    });

    test("preserves line structure for multi-line callers", () => {
      expect(stripMarkdownForPreview("first\n\nsecond")).toContain("\n");
    });

    test("returns empty for empty input", () => {
      expect(stripMarkdownForPreview("")).toBe("");
    });
  });
});

describe("mediaEmbeds", () => {
  const alts = (value: string): string[] =>
    mediaEmbeds(value).map((embed) => embed.alt);

  test("recovers the alts a flattened reply dropped", () => {
    expect(
      alts(
        "![the Q3 chart](https://cdn.example.com/q3.png) ![scene](vellum://workspace/a.mp4)",
      ),
    ).toEqual(["the Q3 chart", "scene"]);
  });

  test("keeps an empty alt as a placeholder rather than dropping it", () => {
    expect(alts("![](https://cdn.example.com/a.png)")).toEqual([""]);
  });

  test("ignores plain links", () => {
    expect(alts("[report.pdf](vellum://workspace/r.pdf)")).toEqual([]);
  });

  test("returns nothing for prose", () => {
    expect(alts("Done, all green.")).toEqual([]);
  });

  // The parser resolves an image description to plain text, so a formatted alt
  // cannot reintroduce the markdown this module exists to remove.
  test("returns a formatted alt already flattened", () => {
    expect(alts("![**chart**](https://example.com/a.png)")).toEqual(["chart"]);
  });

  test("ignores embed syntax quoted inside a code span", () => {
    expect(alts("Use `![alt](https://example.com/a.png)` here")).toEqual([]);
  });

  // Only untracked embeds need naming from their alt: a caller holding
  // attachment metadata has already counted the tracked ones.
  describe("tracking", () => {
    test("marks workspace and host destinations tracked", () => {
      expect(
        mediaEmbeds(
          "![a](vellum://workspace/a.mp4) ![b](vellum://host/tmp/b.png)",
        ).map((embed) => embed.tracked),
      ).toEqual([true, true]);
    });

    test("marks a remote destination untracked", () => {
      expect(
        mediaEmbeds("![a](https://cdn.example.com/a.png)")[0]?.tracked,
      ).toBe(false);
    });

    test("marks a reference embed untracked", () => {
      expect(
        mediaEmbeds("![a][ref]\n\n[ref]: vellum://workspace/a.png")[0]?.tracked,
      ).toBe(false);
    });
  });
});

describe("describeMedia", () => {
  test("names a single label", () => {
    expect(describeMedia(["cut.mp4"])).toBe("Sent cut.mp4");
  });

  test("counts several rather than listing them", () => {
    expect(describeMedia(["a.png", "b.png"])).toBe("Sent 2 attachments");
  });

  test("falls back to generic copy for a label that sanitizes away", () => {
    expect(describeMedia(["\0\x07"])).toBe("Sent an attachment");
  });

  test("returns empty for no labels, leaving the fallback to the caller", () => {
    expect(describeMedia([])).toBe("");
  });
});
