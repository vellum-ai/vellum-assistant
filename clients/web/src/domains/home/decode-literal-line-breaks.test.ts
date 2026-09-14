import { describe, expect, test } from "bun:test";

import { decodeLiteralLineBreaks } from "./decode-literal-line-breaks";

describe("decodeLiteralLineBreaks", () => {
  test("leaves ordinary markdown alone", () => {
    expect(
      decodeLiteralLineBreaks("**3 new emails** and a calendar change."),
    ).toBe("**3 new emails** and a calendar change.");
  });

  test("turns literal newline escapes into real line breaks", () => {
    expect(decodeLiteralLineBreaks("Line one\\n\\nLine two")).toBe(
      "Line one\n\nLine two",
    );
  });

  test("turns literal tab escapes into real tabs", () => {
    expect(decodeLiteralLineBreaks("col a\\tcol b")).toBe("col a\tcol b");
  });

  test("leaves a lone backslash that is not a line-break escape", () => {
    expect(decodeLiteralLineBreaks("path\\file")).toBe("path\\file");
  });
});
