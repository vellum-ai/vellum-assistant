import { describe, expect, test } from "bun:test";

import {
  extractLastCodeBlock,
  formatConversationForExport,
} from "../util/clipboard.js";

describe("formatConversationForExport", () => {
  test("formats user and assistant messages", () => {
    const messages = [
      { role: "user", text: "Hello" },
      { role: "assistant", text: "Hi there!" },
    ];
    expect(formatConversationForExport(messages)).toBe(
      "you> Hello\n\nassistant> Hi there!",
    );
  });

  test("handles a single message", () => {
    const messages = [{ role: "user", text: "Just me" }];
    expect(formatConversationForExport(messages)).toBe("you> Just me");
  });

  test("handles empty messages array", () => {
    expect(formatConversationForExport([])).toBe("");
  });

  test("preserves multiline message text", () => {
    const messages = [{ role: "assistant", text: "Line 1\nLine 2\nLine 3" }];
    expect(formatConversationForExport(messages)).toBe(
      "assistant> Line 1\nLine 2\nLine 3",
    );
  });
});

describe("extractLastCodeBlock", () => {
  test("extracts a simple code block", () => {
    const text = "```\nhello world\n```";
    expect(extractLastCodeBlock(text)).toBe("hello world");
  });

  test("extracts code block with language tag", () => {
    const text = "```typescript\nconst x = 1;\n```";
    expect(extractLastCodeBlock(text)).toBe("const x = 1;");
  });

  test("returns the last code block when multiple exist", () => {
    const text = "```\nfirst\n```\nsome text\n```\nsecond\n```";
    expect(extractLastCodeBlock(text)).toBe("second");
  });

  test("handles empty code blocks", () => {
    const text = "```\n```";
    expect(extractLastCodeBlock(text)).toBe("");
  });

  test("handles empty code blocks with language tag", () => {
    const text = "```python\n```";
    expect(extractLastCodeBlock(text)).toBe("");
  });

  test("does not match inline backticks as closing fence", () => {
    const text = '```\nconst s = "```"\n```';
    expect(extractLastCodeBlock(text)).toBe('const s = "```"');
  });

  test("handles multi-line code blocks", () => {
    const text = "```js\nfunction foo() {\n  return 42;\n}\n```";
    expect(extractLastCodeBlock(text)).toBe(
      "function foo() {\n  return 42;\n}",
    );
  });

  test("returns null when no code blocks exist", () => {
    expect(extractLastCodeBlock("no code here")).toBeNull();
    expect(extractLastCodeBlock("`inline code`")).toBeNull();
  });

  test("extracts last block when separated by text", () => {
    const text = "```\nfirst\n```\nSome explanation\n```\nsecond\n```";
    expect(extractLastCodeBlock(text)).toBe("second");
  });

  test("handles non-empty block followed by empty block with text between", () => {
    const text = "```\nreal code\n```\nSome text\n```\n```";
    expect(extractLastCodeBlock(text)).toBe("");
  });
});
