import { describe, expect, test } from "bun:test";

import {
  escapeInjectedBody,
  extractInjectedConceptSlugs,
  injectedConceptHeader,
  injectedSectionHeader,
  injectedSectionPath,
  parseInjectedSectionPath,
  parseInjectedSections,
  readInjectedBlock,
  renderedBytes,
  unescapeInjectedBody,
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
    // as-is and the parser hands it back unchanged for `sectionKeyTitle`.
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

describe("parseInjectedSections: cards frozen before body escaping", () => {
  // The exact shape earlier builds froze: concept header, the page's `# Title`
  // line, lead prose, a blank line, then the `[sections: …]` TOC line, with
  // cards joined on blank lines behind the shared instruction line.
  const preamble =
    'Use `file_read("memory/concepts/path/to/file.md")` to read the full pages for any of the injected memory summaries you want more information on.';
  const cardA = [
    injectedSectionHeader("topics/page-a", ""),
    "# Page A",
    "lead prose",
    "",
    "# memory/concepts/example.md",
    "more lead prose, after a user-authored line shaped like a header",
    "",
    "[sections: §Notes · §Design]",
  ].join("\n");
  const cardB = [
    injectedSectionHeader("topics/page-b", ""),
    "# Page B",
    "lead b",
    "",
    "[sections: §X]",
  ].join("\n");
  const stub = [
    injectedSectionHeader("topics/stub", ""),
    "# Stub",
    "just a lead, no sections",
  ].join("\n");
  const headless = [
    injectedSectionHeader("topics/headless", ""),
    "prose only, no title line",
    "",
    "[sections: §One]",
  ].join("\n");

  test("a header-shaped line inside a card's lead never splits the card", () => {
    const parsed = parseInjectedSections([preamble, cardA, cardB].join("\n\n"));
    expect(parsed.preamble).toBe(preamble);
    expect(parsed.sections.map(refOf)).toEqual([
      { slug: "topics/page-a", key: "" },
      { slug: "topics/page-b", key: "" },
    ]);
    expect(parsed.sections.map((section) => section.text)).toEqual([
      cardA,
      cardB,
    ]);
  });

  test("a sectionless card followed by a card that opens with its title stays two cards", () => {
    const parsed = parseInjectedSections([preamble, stub, cardB].join("\n\n"));
    expect(parsed.sections.map((section) => section.text)).toEqual([
      stub,
      cardB,
    ]);
  });

  test("a headless card is still a card when the previous card closed with its TOC line, or when it follows a non-card chunk", () => {
    const afterCard = parseInjectedSections(
      [preamble, cardB, headless].join("\n\n"),
    );
    expect(afterCard.sections.map((section) => section.text)).toEqual([
      cardB,
      headless,
    ]);
    const afterHint = parseInjectedSections(
      [preamble, "# Skills\nhint", headless].join("\n\n"),
    );
    expect(afterHint.pieces.map((piece) => piece.text)).toEqual([
      "# Skills\nhint",
      headless,
    ]);
  });

  test("a headless card after a sectionless card is a card when its span is exactly the frozen length the conversation recorded", () => {
    const inner = [preamble, stub, headless].join("\n\n");
    // The old injector recorded each card's UTF-8 length (header through TOC
    // line, joiner excluded); a span that matches it byte for byte is that
    // card, which the shape alone cannot tell.
    const known = parseInjectedSections(inner, {
      knownCardBytes: new Map([
        ["topics/stub", renderedBytes(stub)],
        ["topics/headless", renderedBytes(headless)],
      ]),
    });
    expect(known.sections.map((section) => section.text)).toEqual([
      stub,
      headless,
    ]);
    // Unrecorded, zero, or mismatched bytes leave the shape's verdict: the
    // second header reads as the open card's text (the two shapes are
    // identical on the page).
    const merged = [`${stub}\n\n${headless}`];
    expect(
      parseInjectedSections(inner).sections.map((section) => section.text),
    ).toEqual(merged);
    expect(
      parseInjectedSections(inner, {
        knownCardBytes: new Map([["topics/headless", 0]]),
      }).sections.map((section) => section.text),
    ).toEqual(merged);
    expect(
      parseInjectedSections(inner, {
        knownCardBytes: new Map([
          ["topics/headless", renderedBytes(headless) + 1],
        ]),
      }).sections.map((section) => section.text),
    ).toEqual(merged);
  });

  test("a header-shaped line naming a recorded page stays card text when its span is not that page's frozen card", () => {
    // Page A's lead cites page B's path; page B is a real card in the same
    // block. The cited line's span (the rest of A's lead plus A's TOC) is not
    // B's recorded length, so recorded membership alone never splits A.
    const citingA = [
      injectedSectionHeader("topics/page-a", ""),
      "# Page A",
      "lead prose",
      "",
      injectedSectionHeader("topics/page-b", ""),
      "more lead prose, after a line that cites page B's path",
      "",
      "[sections: §Notes · §Design]",
    ].join("\n");
    const inner = [preamble, citingA, cardB].join("\n\n");
    const parsed = parseInjectedSections(inner, {
      knownCardBytes: new Map([
        ["topics/page-a", renderedBytes(citingA)],
        ["topics/page-b", renderedBytes(cardB)],
      ]),
    });
    expect(parsed.sections.map((section) => section.text)).toEqual([
      citingA,
      cardB,
    ]);
  });

  test("a block rendered by this build escapes TOC-shaped lines, so the card rule never applies to it", () => {
    const body = ["prose", "", "[sections: §A · §B]", "after"].join("\n");
    const escaped = escapeInjectedBody(body);
    expect(escaped).toBe("prose\n\n\\[sections: §A · §B]\nafter");
    const headlessLead = `${injectedSectionHeader("topics/page-b", "")}\nno title line here`;
    const inner = [
      "preamble",
      `${injectedSectionHeader("topics/page-a", "Notes")}\n${escaped}`,
      headlessLead,
    ].join("\n\n");
    expect(parseInjectedSections(inner).sections.map(refOf)).toEqual([
      { slug: "topics/page-a", key: "Notes" },
      { slug: "topics/page-b", key: "" },
    ]);
  });
});

describe("escapeInjectedBody / unescapeInjectedBody", () => {
  const boundaryLines = [
    "# memory/concepts/example.md",
    "# memory/concepts/example.md § Notes",
    "# Skills",
    "# Skill: foo",
    "# CLI command: bar",
    "[sections: §A · §B]",
    "[linked: a · b]",
  ];

  test("prefixes exactly the lines that would parse as grammar", () => {
    const others = [
      "# Title",
      "prose",
      "\\frac{1}{2}",
      "## memory/concepts/example.md",
      " # memory/concepts/example.md",
    ];
    expect(escapeInjectedBody([...others, ...boundaryLines].join("\n"))).toBe(
      [...others, ...boundaryLines.map((line) => `\\${line}`)].join("\n"),
    );
  });

  test("is a bijection, including bodies that already carry the escape", () => {
    const lines = [
      ...boundaryLines,
      "\\# memory/concepts/example.md",
      "\\\\# memory/concepts/example.md",
      "\\# not a boundary",
      "plain",
    ];
    for (const line of lines) {
      expect(unescapeInjectedBody(escapeInjectedBody(line))).toBe(line);
    }
    const body = lines.join("\n");
    expect(unescapeInjectedBody(escapeInjectedBody(body))).toBe(body);
    // Distinct sources escape to distinct forms.
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
