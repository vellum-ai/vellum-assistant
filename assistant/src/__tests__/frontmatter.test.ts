import { describe, expect, test } from "bun:test";

import {
  FRONTMATTER_REGEX,
  parseFrontmatterFields,
} from "../skills/frontmatter.js";

describe("FRONTMATTER_REGEX", () => {
  test("matches a standard frontmatter block", () => {
    const input = '---\nname: "Test"\n---\nBody content';
    expect(FRONTMATTER_REGEX.test(input)).toBe(true);
  });

  test("does not match content without frontmatter delimiters", () => {
    expect(FRONTMATTER_REGEX.test("no frontmatter here")).toBe(false);
  });

  test("does not match frontmatter that does not start at beginning of file", () => {
    expect(FRONTMATTER_REGEX.test('text before\n---\nname: "X"\n---\n')).toBe(
      false,
    );
  });

  test("matches frontmatter with CRLF line endings", () => {
    const input = '---\r\nname: "Test"\r\n---\r\nBody';
    expect(FRONTMATTER_REGEX.test(input)).toBe(true);
  });

  test("matches frontmatter at EOF without trailing newline", () => {
    const input = '---\nname: "Test"\n---';
    expect(FRONTMATTER_REGEX.test(input)).toBe(true);
  });
});

describe("parseFrontmatterFields", () => {
  test("returns null when no frontmatter is present", () => {
    expect(parseFrontmatterFields("Just some text")).toBeNull();
    expect(parseFrontmatterFields("")).toBeNull();
  });

  test("parses unquoted values", () => {
    const result = parseFrontmatterFields("---\nkey: value\n---\nBody");
    expect(result).not.toBeNull();
    expect(result!.fields.key).toBe("value");
    expect(result!.body).toBe("Body");
  });

  test("parses double-quoted values", () => {
    const result = parseFrontmatterFields('---\nname: "Test Skill"\n---\n');
    expect(result).not.toBeNull();
    expect(result!.fields.name).toBe("Test Skill");
  });

  test("parses single-quoted values", () => {
    const result = parseFrontmatterFields("---\nname: 'Test Skill'\n---\n");
    expect(result).not.toBeNull();
    expect(result!.fields.name).toBe("Test Skill");
  });

  test("handles multiple fields", () => {
    const input =
      '---\nname: "Alpha"\ndescription: "Beta"\nemoji: "X"\n---\nBody';
    const result = parseFrontmatterFields(input);
    expect(result).not.toBeNull();
    expect(result!.fields.name).toBe("Alpha");
    expect(result!.fields.description).toBe("Beta");
    expect(result!.fields.emoji).toBe("X");
  });

  test("skips empty lines and comments", () => {
    const input =
      '---\nname: "Test"\n\n# a comment\ndescription: "Desc"\n---\nBody';
    const result = parseFrontmatterFields(input);
    expect(result).not.toBeNull();
    expect(result!.fields.name).toBe("Test");
    expect(result!.fields.description).toBe("Desc");
  });

  // -- Escape sequence handling (double-quoted) --

  test("unescapes \\n to newline in double-quoted values", () => {
    const result = parseFrontmatterFields('---\ndesc: "Line1\\nLine2"\n---\n');
    expect(result!.fields.desc).toBe("Line1\nLine2");
  });

  test("unescapes \\r to carriage return in double-quoted values", () => {
    const result = parseFrontmatterFields('---\ndesc: "Line1\\rLine2"\n---\n');
    expect(result!.fields.desc).toBe("Line1\rLine2");
  });

  test("unescapes \\\\ to single backslash in double-quoted values", () => {
    const result = parseFrontmatterFields('---\npath: "C:\\\\Users"\n---\n');
    expect(result!.fields.path).toBe("C:\\Users");
  });

  test('unescapes \\" to literal quote in double-quoted values', () => {
    const result = parseFrontmatterFields(
      '---\nname: "Say \\"hello\\""\n---\n',
    );
    expect(result!.fields.name).toBe('Say "hello"');
  });

  test("handles \\\\n correctly (escaped backslash followed by n, not newline)", () => {
    const result = parseFrontmatterFields('---\npath: "back\\\\name"\n---\n');
    expect(result!.fields.path).toBe("back\\name");
  });

  test("does not unescape sequences in single-quoted values", () => {
    const result = parseFrontmatterFields("---\npath: 'back\\\\slash'\n---\n");
    // Single-quoted YAML treats backslashes literally
    expect(result!.fields.path).toBe("back\\\\slash");
  });

  test("preserves \\n literal in single-quoted values", () => {
    const result = parseFrontmatterFields("---\ndesc: 'has \\n in it'\n---\n");
    expect(result!.fields.desc).toBe("has \\n in it");
  });

  // -- Multiple colons edge case --

  test("handles values containing colons (only splits on first colon)", () => {
    const result = parseFrontmatterFields(
      '---\nurl: "http://example.com:8080"\n---\n',
    );
    expect(result!.fields.url).toBe("http://example.com:8080");
  });

  test("handles unquoted values containing colons", () => {
    const result = parseFrontmatterFields(
      "---\nurl: http://example.com:8080/path\n---\n",
    );
    expect(result!.fields.url).toBe("http://example.com:8080/path");
  });

  test("key with colon in value and no quotes", () => {
    const result = parseFrontmatterFields("---\ntime: 12:30:00\n---\n");
    expect(result!.fields.time).toBe("12:30:00");
  });

  // -- Body extraction --

  test("body includes everything after the closing delimiter", () => {
    const input = '---\nname: "X"\n---\nLine 1\nLine 2\nLine 3';
    const result = parseFrontmatterFields(input);
    expect(result!.body).toBe("Line 1\nLine 2\nLine 3");
  });

  test("body is empty string when nothing follows delimiter", () => {
    const input = '---\nname: "X"\n---\n';
    const result = parseFrontmatterFields(input);
    expect(result!.body).toBe("");
  });

  // -- Edge cases with quoting --

  test("empty double-quoted value", () => {
    const result = parseFrontmatterFields('---\nname: ""\n---\n');
    expect(result!.fields.name).toBe("");
  });

  test("empty single-quoted value", () => {
    const result = parseFrontmatterFields("---\nname: ''\n---\n");
    expect(result!.fields.name).toBe("");
  });

  test("value with leading/trailing whitespace inside quotes", () => {
    const result = parseFrontmatterFields('---\nname: "  spaced  "\n---\n');
    expect(result!.fields.name).toBe("  spaced  ");
  });

  // -- YAML array values --

  test("YAML inline array is parsed as a native array", () => {
    const result = parseFrontmatterFields("---\nincludes: [a, b]\n---\n");
    expect(result!.fields.includes).toEqual(["a", "b"]);
  });

  test("JSON-style array value is parsed as a native array", () => {
    const result = parseFrontmatterFields('---\nincludes: ["a","b"]\n---\n');
    expect(result!.fields.includes).toEqual(["a", "b"]);
  });

  // -- Boolean-like values --

  test("boolean values are parsed as native booleans", () => {
    const result = parseFrontmatterFields(
      "---\nuser-invocable: false\ndisable-model-invocation: true\n---\n",
    );
    expect(result!.fields["user-invocable"]).toBe(false);
    expect(result!.fields["disable-model-invocation"]).toBe(true);
  });

  // -- CRLF handling --

  test("handles CRLF line endings in frontmatter fields", () => {
    const input = '---\r\nname: "Test"\r\ndescription: "Desc"\r\n---\r\nBody';
    const result = parseFrontmatterFields(input);
    expect(result).not.toBeNull();
    expect(result!.fields.name).toBe("Test");
    expect(result!.fields.description).toBe("Desc");
    expect(result!.body).toBe("Body");
  });

  // -- Multiple escape sequences in one value --

  test("handles multiple escape sequences in a single double-quoted value", () => {
    const result = parseFrontmatterFields('---\ndesc: "a\\nb\\rc\\\\"\n---\n');
    expect(result!.fields.desc).toBe("a\nb\rc\\");
  });

  // -- YAML nested metadata parsing --

  test("parses YAML nested metadata as proper object", () => {
    const input = [
      "---",
      'name: "Test"',
      'description: "A test skill"',
      "metadata:",
      '  emoji: "\uD83D\uDD0C"',
      "  vellum:",
      '    display-name: "Test Skill"',
      "    user-invocable: false",
      "---",
      "Body",
    ].join("\n");
    const result = parseFrontmatterFields(input);
    expect(result).not.toBeNull();
    expect(result!.fields.name).toBe("Test");
    expect(result!.fields.metadata).toEqual({
      emoji: "\uD83D\uDD0C",
      vellum: {
        "display-name": "Test Skill",
        "user-invocable": false,
      },
    });
  });

  test("parses YAML metadata with arrays and nested objects", () => {
    const input = [
      "---",
      'name: "Test"',
      'description: "A test skill"',
      "metadata:",
      "  vellum:",
      "    requires:",
      "      bins:",
      "        - node",
      "        - npm",
      "      env:",
      "        - API_KEY",
      "        - SECRET",
      "---",
      "Body",
    ].join("\n");
    const result = parseFrontmatterFields(input);
    expect(result).not.toBeNull();
    const meta = result!.fields.metadata as Record<string, unknown>;
    const vellum = meta.vellum as Record<string, unknown>;
    expect(vellum.requires).toEqual({
      bins: ["node", "npm"],
      env: ["API_KEY", "SECRET"],
    });
  });

  test("returns null for invalid YAML frontmatter", () => {
    // Tabs are invalid in YAML indentation — should return null
    const input = "---\nname: valid\nbad:\n\t- indentation\n---\nBody";
    const result = parseFrontmatterFields(input);
    expect(result).toBeNull();
  });

  test("handles empty frontmatter block", () => {
    const input = "---\n\n---\nBody";
    const result = parseFrontmatterFields(input);
    expect(result).not.toBeNull();
    expect(result!.fields).toEqual({});
    expect(result!.body).toBe("Body");
  });
});
