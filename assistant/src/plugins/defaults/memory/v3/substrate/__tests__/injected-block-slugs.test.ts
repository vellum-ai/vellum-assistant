import { describe, expect, test } from "bun:test";

import {
  extractInjectedConceptSlugs,
  injectedConceptHeader,
  readInjectedBlock,
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
