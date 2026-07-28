import { describe, expect, test } from "bun:test";

import type { Code, Paragraph } from "mdast";

import { parseMarkdown } from "./parse.js";

describe("parseMarkdown", () => {
  test("parses prose into a paragraph", () => {
    const tree = parseMarkdown("hello world");
    expect(tree.type).toBe("root");
    expect(tree.children[0].type).toBe("paragraph");
  });

  test("parses GFM tables (remark-gfm is active)", () => {
    const tree = parseMarkdown("| A | B |\n| --- | --- |\n| 1 | 2 |");
    expect(tree.children[0].type).toBe("table");
  });

  test("parses fenced code with its language", () => {
    const tree = parseMarkdown("```ts\nconst x = 1;\n```");
    const code = tree.children[0] as Code;
    expect(code.type).toBe("code");
    expect(code.lang).toBe("ts");
  });

  test("parses inline strong / emphasis / link as structured spans", () => {
    const tree = parseMarkdown("**b** _i_ [x](https://e.com)");
    const para = tree.children[0] as Paragraph;
    const types = para.children.map((c) => c.type);
    expect(types).toContain("strong");
    expect(types).toContain("emphasis");
    expect(types).toContain("link");
  });
});
