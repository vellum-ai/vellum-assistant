import { describe, expect, test } from "bun:test";

import { sanitizeForTts } from "../tts-text-sanitizer.js";

describe("sanitizeForTts", () => {
  describe("markdown links", () => {
    test("strips markdown links, keeping link text", () => {
      expect(sanitizeForTts("Check [this link](https://example.com)")).toBe(
        "Check this link",
      );
    });

    test("handles multiple links", () => {
      expect(
        sanitizeForTts("See [foo](http://a.com) and [bar](http://b.com)"),
      ).toBe("See foo and bar");
    });

    test("preserves Fish Audio S2 bracket annotations", () => {
      expect(sanitizeForTts("Hello [laughter] world")).toBe(
        "Hello [laughter] world",
      );
      expect(sanitizeForTts("[breath] ok")).toBe("[breath] ok");
    });

    test("handles URLs with balanced parentheses (e.g. Wikipedia)", () => {
      expect(
        sanitizeForTts(
          "See [Function](https://en.wikipedia.org/wiki/Function_(mathematics))",
        ),
      ).toBe("See Function");
    });

    test("handles URLs with multiple balanced parentheses groups", () => {
      expect(
        sanitizeForTts("[link](http://example.com/a_(b)_c_(d))"),
      ).toBe("link");
    });
  });

  describe("bold and italic", () => {
    test("strips bold (asterisks)", () => {
      expect(sanitizeForTts("Hello **world**")).toBe("Hello world");
    });

    test("strips bold (underscores)", () => {
      expect(sanitizeForTts("Hello __world__")).toBe("Hello world");
    });

    test("strips italic (asterisks)", () => {
      expect(sanitizeForTts("Hello *world*")).toBe("Hello world");
    });

    test("strips italic (underscores)", () => {
      expect(sanitizeForTts("Hello _world_")).toBe("Hello world");
    });

    test("strips bold+italic (asterisks)", () => {
      expect(sanitizeForTts("Hello ***world***")).toBe("Hello world");
    });

    test("strips bold+italic (underscores)", () => {
      expect(sanitizeForTts("Hello ___world___")).toBe("Hello world");
    });

    test("preserves arithmetic asterisks", () => {
      expect(sanitizeForTts("5 * 3 = 15")).toBe("5 * 3 = 15");
    });

    test("preserves identifiers with underscores", () => {
      expect(sanitizeForTts("The my_var variable")).toBe(
        "The my_var variable",
      );
    });

    test("preserves snake_case identifiers", () => {
      expect(sanitizeForTts("use some_function_name here")).toBe(
        "use some_function_name here",
      );
    });
  });

  describe("headers", () => {
    test("strips h1", () => {
      expect(sanitizeForTts("# Header\n\nSome text")).toBe(
        "Header\n\nSome text",
      );
    });

    test("strips h2", () => {
      expect(sanitizeForTts("## Sub Header")).toBe("Sub Header");
    });

    test("strips h3 through h6", () => {
      expect(sanitizeForTts("### H3")).toBe("H3");
      expect(sanitizeForTts("#### H4")).toBe("H4");
      expect(sanitizeForTts("##### H5")).toBe("H5");
      expect(sanitizeForTts("###### H6")).toBe("H6");
    });

    test("does not strip # in middle of line", () => {
      expect(sanitizeForTts("Issue #42")).toBe("Issue #42");
    });
  });

  describe("code", () => {
    test("strips code fences, keeping content", () => {
      const input = "Here:\n```js\nconst x = 1;\n```\nDone.";
      expect(sanitizeForTts(input)).toBe("Here:\nconst x = 1;\nDone.");
    });

    test("strips inline code backticks", () => {
      expect(sanitizeForTts("Use `console.log` here")).toBe(
        "Use console.log here",
      );
    });

    test("preserves # comments inside code fences", () => {
      const input = "Example:\n```python\n# This is a comment\nprint('hi')\n```\nDone.";
      expect(sanitizeForTts(input)).toBe(
        "Example:\n# This is a comment\nprint('hi')\nDone.",
      );
    });

    test("preserves shell comments inside code fences", () => {
      const input = "Run:\n```bash\n## Install deps\napt-get install curl\n```";
      expect(sanitizeForTts(input)).toBe(
        "Run:\n## Install deps\napt-get install curl\n",
      );
    });
  });

  describe("bullet markers", () => {
    test("strips dash bullets", () => {
      expect(sanitizeForTts("- First\n- Second")).toBe("First\nSecond");
    });

    test("strips asterisk bullets", () => {
      expect(sanitizeForTts("* First\n* Second")).toBe("First\nSecond");
    });

    test("does not strip dashes mid-line", () => {
      expect(sanitizeForTts("well-known fact")).toBe("well-known fact");
    });
  });

  describe("emojis", () => {
    test("strips simple emojis", () => {
      expect(sanitizeForTts("Hello world 👋")).toBe("Hello world ");
    });

    test("strips compound emojis (ZWJ sequences)", () => {
      // Family emoji: man + ZWJ + woman + ZWJ + girl
      expect(sanitizeForTts("Family: 👨‍👩‍👧")).toBe("Family: ");
    });

    test("strips emojis with skin tone modifiers", () => {
      expect(sanitizeForTts("Wave 👋🏽 hello")).toBe("Wave hello");
    });

    test("strips flag emojis", () => {
      // Flags are regional indicator sequences (Extended_Pictographic)
      expect(sanitizeForTts("Hello 🇺🇸 world")).toBe("Hello world");
    });

    test("strips emojis with variation selectors", () => {
      // Heart with variation selector
      expect(sanitizeForTts("Love ❤️ you")).toBe("Love you");
    });

    test("preserves numbers and currency", () => {
      expect(sanitizeForTts("$100.50 and €200")).toBe("$100.50 and €200");
    });

    test("preserves punctuation", () => {
      expect(sanitizeForTts("Hello, world! How are you?")).toBe(
        "Hello, world! How are you?",
      );
    });
  });

  describe("whitespace collapsing", () => {
    test("collapses multiple spaces to single space", () => {
      expect(sanitizeForTts("Hello    world")).toBe("Hello world");
    });

    test("collapses multiple blank lines to single newline", () => {
      expect(sanitizeForTts("Hello\n\n\n\nworld")).toBe("Hello\n\nworld");
    });
  });

  describe("combined transformations", () => {
    test("acceptance: Hello **world** with emoji", () => {
      expect(sanitizeForTts("Hello **world** 👋")).toBe("Hello world ");
    });

    test("acceptance: markdown link", () => {
      expect(
        sanitizeForTts("Check [this link](https://example.com)"),
      ).toBe("Check this link");
    });

    test("acceptance: arithmetic preserved", () => {
      expect(sanitizeForTts("5 * 3 = 15")).toBe("5 * 3 = 15");
    });

    test("acceptance: header with text", () => {
      expect(sanitizeForTts("# Header\n\nSome text")).toBe(
        "Header\n\nSome text",
      );
    });

    test("complex mixed markdown and emojis", () => {
      const input =
        "# Welcome 🎉\n\nHello **world**! Check [docs](http://x.com).\n\n- Item *one*\n- Item `two`";
      const expected =
        "Welcome \n\nHello world! Check docs.\n\nItem one\nItem two";
      expect(sanitizeForTts(input)).toBe(expected);
    });
  });

  describe("edge cases", () => {
    test("empty string", () => {
      expect(sanitizeForTts("")).toBe("");
    });

    test("already-clean text", () => {
      const clean = "Hello, this is plain text.";
      expect(sanitizeForTts(clean)).toBe(clean);
    });

    test("nested markdown (bold inside italic)", () => {
      expect(sanitizeForTts("*Hello **world***")).toBe("Hello world");
    });

    test("partial markdown (unmatched asterisks)", () => {
      expect(sanitizeForTts("Hello **world")).toBe("Hello **world");
    });

    test("idempotency: applying twice gives same result", () => {
      const input = "# Hello **world** 👋\n\n- Item *one*\n- [link](http://x.com)";
      const once = sanitizeForTts(input);
      const twice = sanitizeForTts(once);
      expect(twice).toBe(once);
    });

    test("preserves trailing whitespace for streaming chunks", () => {
      // Streaming chunks must keep trailing spaces so word boundaries survive
      // concatenation: "Hello " + "world" = "Hello world", not "Helloworld"
      expect(sanitizeForTts("Hello ")).toBe("Hello ");
      expect(sanitizeForTts("the quick ")).toBe("the quick ");
    });
  });
});
