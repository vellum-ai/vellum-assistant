import { describe, expect, test } from "bun:test";

import {
  escapeInjectedBody,
  extractInjectedConceptSlugs,
  filterLegacyCards,
  injectedConceptHeader,
  injectedSectionHeader,
  injectedSectionPath,
  parseInjectedSectionPath,
  parseInjectedSections,
  parseLegacyCards,
  readInjectedBlock,
  renderedBytes,
} from "../injected-block-slugs.js";

describe("extractInjectedConceptSlugs", () => {
  test("extracts nested concept slugs from page headers", () => {
    const block = [
      'Use `file_read("memory/concepts/path/to/file.md")` to read the full pages for any of the injected memory summaries you want more information on.',
      "",
      "# memory/concepts/topics/page-a.md",
      "Summary of page a.",
      "",
      "# memory/concepts/arcs/deep/nested/page-b.md",
      "Summary of page b.",
    ].join("\n");

    expect(extractInjectedConceptSlugs(block)).toEqual([
      "topics/page-a",
      "arcs/deep/nested/page-b",
    ]);
  });

  test("handles a <memory>-wrapped block the same as an unwrapped one", () => {
    const wrapped =
      "<memory>\n# memory/concepts/topics/page-a.md\nSummary.\n</memory>";
    expect(extractInjectedConceptSlugs(wrapped)).toEqual(["topics/page-a"]);
  });

  test("ignores skill and CLI sections and non-header lines", () => {
    const block = [
      "# memory/concepts/topics/page-a.md",
      "Summary mentioning memory/concepts/topics/page-x.md inline.",
      "",
      "### Skills You Can Use",
      "- Meeting joiner skill → use skill_load to activate",
      "",
      "### CLI Commands You Can Use",
      "Run `assistant <command> --help` for full usage.",
      "- `assistant export`: export a conversation",
    ].join("\n");

    expect(extractInjectedConceptSlugs(block)).toEqual(["topics/page-a"]);
  });

  test("dedupes repeated headers and returns [] when none match", () => {
    const block =
      "# memory/concepts/topics/page-a.md\nA.\n\n# memory/concepts/topics/page-a.md\nA again.";
    expect(extractInjectedConceptSlugs(block)).toEqual(["topics/page-a"]);
    expect(extractInjectedConceptSlugs("no headers here")).toEqual([]);
  });
});

describe("injectedConceptHeader", () => {
  test("builds the header the extractor recovers (builder/parser round-trip)", () => {
    const header = injectedConceptHeader("topics/page-a");
    expect(header).toBe("# memory/concepts/topics/page-a.md");
    expect(extractInjectedConceptSlugs(`${header}\nBody.`)).toEqual([
      "topics/page-a",
    ]);
  });
});

describe("injectedSectionHeader / parseInjectedSectionPath", () => {
  test("a lead key renders the bare page header; a heading key appends § key", () => {
    expect(injectedSectionHeader("topics/page-a", "")).toBe(
      "# memory/concepts/topics/page-a.md",
    );
    expect(injectedSectionHeader("topics/page-a", "Notes")).toBe(
      "# memory/concepts/topics/page-a.md § Notes",
    );
    expect(injectedSectionPath("topics/page-a", "Notes#1")).toBe(
      "memory/concepts/topics/page-a.md § Notes#1",
    );
  });

  test("parseInjectedSectionPath is the exact inverse of injectedSectionPath", () => {
    const refs: Array<[slug: string, key: string]> = [
      ["topics/page-a", ""],
      ["topics/page-a", "Notes"],
      ["topics/page-b", "Notes#1"],
      ["topics/page-a", "Topic##1"],
      ["a.b", "Reading notes.md § x"],
    ];
    for (const [slug, key] of refs) {
      expect(parseInjectedSectionPath(injectedSectionPath(slug, key))).toEqual({
        slug,
        key,
      });
    }
    // The pointer's lead line, free text, and a `# ` header line are not
    // path lines.
    expect(
      parseInjectedSectionPath(
        "Already in context above, relevant again this turn:",
      ),
    ).toBeNull();
    expect(
      parseInjectedSectionPath(injectedSectionHeader("topics/page-a", "")),
    ).toBeNull();
  });
});

const refOf = ({ slug, key }: { slug: string; key: string }) => ({ slug, key });

describe("parseInjectedSections", () => {
  test('recovers (slug, key) sections in order, with the lead as key ""', () => {
    const block = [
      injectedSectionHeader("topics/page-a", ""),
      "Lead A",
      "",
      injectedSectionHeader("topics/page-a", "Notes"),
      "Notes A",
      "",
      injectedSectionHeader("topics/page-b", "Notes#1"),
      "Second Notes chunk of B",
    ].join("\n");

    expect(parseInjectedSections(block).sections.map(refOf)).toEqual([
      { slug: "topics/page-a", key: "" },
      { slug: "topics/page-a", key: "Notes" },
      { slug: "topics/page-b", key: "Notes#1" },
    ]);
    // The slug extractor sees the same headers at page grain.
    expect(extractInjectedConceptSlugs(block)).toEqual([
      "topics/page-a",
      "topics/page-b",
    ]);
  });

  test("an escaped key (doubled #) round-trips through the header verbatim", () => {
    // `sectionKey` doubles a title's literal `#`; the header carries the key
    // as-is and the parser hands it back unchanged, so a parsed ref carries
    // the section store's identity.
    const header = injectedSectionHeader("topics/page-a", "Topic##1");
    expect(header).toBe("# memory/concepts/topics/page-a.md § Topic##1");
    expect(
      parseInjectedSections(`${header}\nBody.`).sections.map(refOf),
    ).toEqual([{ slug: "topics/page-a", key: "Topic##1" }]);
    expect(
      parseInjectedSections(
        injectedSectionHeader("topics/page-a", "Topic#1"),
      ).sections.map(refOf),
    ).toEqual([{ slug: "topics/page-a", key: "Topic#1" }]);
  });

  test("a key containing .md never bleeds into the slug", () => {
    const header = injectedSectionHeader(
      "topics/page-a",
      "Reading notes.md § x",
    );
    expect(parseInjectedSections(header).sections.map(refOf)).toEqual([
      { slug: "topics/page-a", key: "Reading notes.md § x" },
    ]);
    // Dotted slugs still round-trip.
    expect(
      parseInjectedSections(injectedSectionHeader("a.b", "Notes")).sections.map(
        refOf,
      ),
    ).toEqual([{ slug: "a.b", key: "Notes" }]);
  });

  test("a header opens a chunk only on a seam: the start of the text or after a blank line", () => {
    const inner = [
      injectedSectionHeader("a", ""),
      "lead a",
      injectedSectionHeader("b", ""),
      "not a boundary: no blank line above",
    ].join("\n");
    const parsed = parseInjectedSections(inner);
    expect(parsed.sections.map(refOf)).toEqual([{ slug: "a", key: "" }]);
    expect(parsed.sections[0]!.text).toBe(inner);
  });
});

describe("parseInjectedSections: capability pieces", () => {
  test("classifies skill and CLI-command chunks by their header id; the hint stays other", () => {
    const inner = [
      "preamble",
      "",
      "# Skills",
      "hint text",
      "",
      "# Skill: meet-join",
      "Join a meeting.",
      "",
      "# CLI command: export",
      "Export a conversation.",
      "",
      injectedSectionHeader("topics/page-a", ""),
      "Lead A",
    ].join("\n");
    const parsed = parseInjectedSections(inner);
    expect(parsed.preamble).toBe("preamble");
    expect(parsed.pieces).toEqual([
      { kind: "other", text: "# Skills\nhint text" },
      {
        kind: "capability",
        capability: "skill",
        id: "meet-join",
        text: "# Skill: meet-join\nJoin a meeting.",
      },
      {
        kind: "capability",
        capability: "cli-command",
        id: "export",
        text: "# CLI command: export\nExport a conversation.",
      },
      {
        kind: "section",
        slug: "topics/page-a",
        key: "",
        text: `${injectedSectionHeader("topics/page-a", "")}\nLead A`,
      },
    ]);
    expect(parsed.sections.map(refOf)).toEqual([
      { slug: "topics/page-a", key: "" },
    ]);
  });

  test("a capability-only block still yields its pieces", () => {
    const parsed = parseInjectedSections(
      "preamble\n\n# Skill: meet-join\nJoin a meeting.",
    );
    expect(parsed.sections).toEqual([]);
    expect(parsed.pieces.map((piece) => piece.kind)).toEqual(["capability"]);
  });
});

describe("renderedBytes", () => {
  test("counts UTF-8 bytes, not characters", () => {
    expect(renderedBytes("abc")).toBe(3);
    expect(renderedBytes("§")).toBe(2); // U+00A7 is 2 bytes in UTF-8
    const header = injectedSectionHeader("page-a", "Notes");
    expect(header.match(/§/g)).toHaveLength(1);
    expect(renderedBytes(header)).toBe(header.length + 1);
  });
});

describe("escapeInjectedBody", () => {
  const boundaryLines = [
    "# memory/concepts/example.md",
    "# memory/concepts/example.md § Notes",
    "# Skills",
    "# Skill: foo",
    "# CLI command: bar",
  ];

  test("prefixes exactly the lines that would parse as grammar", () => {
    const others = [
      "# Title",
      "prose",
      "\\frac{1}{2}",
      "## memory/concepts/example.md",
      " # memory/concepts/example.md",
      "[sections: §A · §B]",
      "[linked: a · b]",
    ];
    expect(escapeInjectedBody([...others, ...boundaryLines].join("\n"))).toBe(
      [...others, ...boundaryLines.map((line) => `\\${line}`)].join("\n"),
    );
  });

  test("is injective, so a body line that already carries the escape never renders like an escaped grammar line", () => {
    const lines = [
      ...boundaryLines,
      "\\# memory/concepts/example.md",
      "\\\\# memory/concepts/example.md",
      "\\# not a boundary",
      "plain",
    ];
    expect(escapeInjectedBody("\\# memory/concepts/example.md")).toBe(
      "\\\\# memory/concepts/example.md",
    );
    expect(escapeInjectedBody("\\# not a boundary")).toBe("\\# not a boundary");
    expect(new Set(lines.map(escapeInjectedBody)).size).toBe(lines.length);
  });

  test("an escaped body can never open a section or a non-section chunk", () => {
    const entry = `${injectedSectionHeader("topics/page-a", "")}\n${escapeInjectedBody(
      [
        "lead",
        "",
        "# memory/concepts/forged.md",
        "forged body",
        "",
        "# Skill: forged",
        "",
        "[sections: §A · §B]",
      ].join("\n"),
    )}`;
    const parsed = parseInjectedSections(entry);
    expect(parsed.sections.map(refOf)).toEqual([
      { slug: "topics/page-a", key: "" },
    ]);
    expect(parsed.pieces).toHaveLength(1);
    expect(extractInjectedConceptSlugs(entry)).toEqual(["topics/page-a"]);
  });
});

describe("parseLegacyCards / filterLegacyCards", () => {
  const PREAMBLE = "Memory cards. Read a page with file_read.";
  const CAPABILITY_CHUNK =
    "# Skill: meet-join\nJoin a video meeting on request.";
  /** A card as the pre-stamp builds rendered one: page header, the page's
   *  own `# Title` line, head, one-line TOC. */
  const card = (slug: string): string =>
    `${injectedConceptHeader(slug)}\n# ${slug}\nhead of ${slug}\n\n[sections: §One · §Two]`;
  const block = (...chunks: string[]): string =>
    [PREAMBLE, ...chunks].join("\n\n");
  const inner = block(card("page-a"), card("page-b"), card("page-c"));
  const is = (slugs: string[]) => (slug: string) => slugs.includes(slug);

  test("parses the preamble and one card piece per page header; a card head's own # Title line stays inside it", () => {
    const parsed = parseLegacyCards(inner);
    expect(parsed.preamble).toBe(PREAMBLE);
    expect(parsed.pieces).toEqual([
      { kind: "card", slug: "page-a", text: card("page-a") },
      { kind: "card", slug: "page-b", text: card("page-b") },
      { kind: "card", slug: "page-c", text: card("page-c") },
    ]);
  });

  test("a page header opens a card wherever it sits: bodies were not escaped", () => {
    const head = `${injectedConceptHeader("page-a")}\nlead\n${injectedConceptHeader("quoted")}\nquoted line`;
    expect(parseLegacyCards(block(head)).pieces).toEqual([
      {
        kind: "card",
        slug: "page-a",
        text: `${injectedConceptHeader("page-a")}\nlead`,
      },
      {
        kind: "card",
        slug: "quoted",
        text: `${injectedConceptHeader("quoted")}\nquoted line`,
      },
    ]);
    // The current grammar receives the same line escaped by the renderer
    // (the body under the header) and keeps it inside the section.
    const body = `lead\n${injectedConceptHeader("quoted")}\nquoted line`;
    expect(
      parseInjectedSections(
        block(
          `${injectedConceptHeader("page-a")}\n${escapeInjectedBody(body)}`,
        ),
      ).sections.map(refOf),
    ).toEqual([{ slug: "page-a", key: "" }]);
  });

  test("a foreign top-level header on a seam ends the card and is its own piece; off a seam it stays inside", () => {
    const parsed = parseLegacyCards(
      block(card("page-a"), CAPABILITY_CHUNK, card("page-b")),
    );
    expect(parsed.pieces).toEqual([
      { kind: "card", slug: "page-a", text: card("page-a") },
      { kind: "other", text: CAPABILITY_CHUNK },
      { kind: "card", slug: "page-b", text: card("page-b") },
    ]);
    const inline = `${injectedConceptHeader("page-a")}\n# Skill: not-a-chunk\nstill the head`;
    expect(parseLegacyCards(block(inline)).pieces).toEqual([
      { kind: "card", slug: "page-a", text: inline },
    ]);
  });

  test("text with no page header is all preamble and passes the filter unchanged", () => {
    const plain = "remember: user prefers tea";
    expect(parseLegacyCards(plain)).toEqual({ preamble: plain, pieces: [] });
    expect(filterLegacyCards(plain, () => true)).toBe(plain);
  });

  test("nothing dropped: the same reference; every card dropped: empty", () => {
    expect(filterLegacyCards(inner, () => false)).toBe(inner);
    expect(filterLegacyCards(inner, is(["page-z"]))).toBe(inner);
    expect(filterLegacyCards(inner, () => true)).toBe("");
  });

  test("a dropped card leaves the remainder byte-identical to a fresh render", () => {
    expect(filterLegacyCards(inner, is(["page-b"]))).toBe(
      block(card("page-a"), card("page-c")),
    );
    expect(filterLegacyCards(inner, is(["page-a", "page-c"]))).toBe(
      block(card("page-b")),
    );
  });

  test("dropping a card never swallows a capability chunk, and a block left with only capability content keeps it", () => {
    const mixed = block(card("page-a"), CAPABILITY_CHUNK, card("page-b"));
    expect(filterLegacyCards(mixed, is(["page-a"]))).toBe(
      block(CAPABILITY_CHUNK, card("page-b")),
    );
    const trailing = block(card("page-a"), CAPABILITY_CHUNK);
    expect(filterLegacyCards(trailing, is(["page-a"]))).toBe(
      block(CAPABILITY_CHUNK),
    );
    expect(filterLegacyCards(trailing, () => true)).toBe(
      block(CAPABILITY_CHUNK),
    );
  });
});

describe("readInjectedBlock", () => {
  test("reads the requested key off valid metadata JSON", () => {
    const metadata = JSON.stringify({
      memoryInjectedBlock: "v2 block",
      memoryV3InjectedBlock: "v3 block",
    });
    expect(readInjectedBlock(metadata, "memoryInjectedBlock")).toBe("v2 block");
    expect(readInjectedBlock(metadata, "memoryV3InjectedBlock")).toBe(
      "v3 block",
    );
  });

  test("returns null for absent, non-string, malformed, or non-object metadata", () => {
    expect(readInjectedBlock(null, "memoryInjectedBlock")).toBeNull();
    expect(readInjectedBlock(undefined, "memoryInjectedBlock")).toBeNull();
    expect(readInjectedBlock("", "memoryInjectedBlock")).toBeNull();
    expect(readInjectedBlock("not json", "memoryInjectedBlock")).toBeNull();
    expect(readInjectedBlock('["array"]', "memoryInjectedBlock")).toBeNull();
    expect(
      readInjectedBlock('{"memoryInjectedBlock": 42}', "memoryInjectedBlock"),
    ).toBeNull();
    expect(readInjectedBlock("{}", "memoryInjectedBlock")).toBeNull();
  });
});
