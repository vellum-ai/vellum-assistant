/**
 * Tests for the PromptTab section rendering. Renders to static markup
 * (no DOM), mirroring `compaction-tab.test.tsx`, and asserts that text
 * sections render as Markdown while tool results render as code-style
 * `<pre>` text.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { PromptTab } from "./prompt-tab";
import type {
    LLMContextSection,
    LLMRequestLogEntry,
} from "@vellumai/assistant-api";

function makeEntry(sections: LLMContextSection[]): LLMRequestLogEntry {
  return {
    id: "call-test-1",
    createdAt: Date.parse("2026-05-26T13:30:00Z"),
    requestPayload: null,
    responsePayload: null,
    requestSections: sections,
  };
}

function render(sections: LLMContextSection[]): string {
  return renderToStaticMarkup(<PromptTab entry={makeEntry(sections)} />);
}

describe("PromptTab", () => {
  test("renders text sections as Markdown", () => {
    const html = render([
      {
        kind: "message",
        label: "User message 1",
        role: "user",
        toolName: null,
        text: "# Heading\n\nplain prose",
        data: null,
      },
    ]);

    expect(html).toContain("<h1");
    expect(html).toContain("Heading");
  });

  test("renders tool result text in a code-style pre block, not Markdown", () => {
    const html = render([
      {
        kind: "tool_result",
        label: "User message 1 tool result",
        role: "user",
        toolName: "tu-1",
        text: "# not-a-heading\nfile_a.txt file_b.txt",
        data: null,
      },
    ]);

    expect(html).not.toContain("<h1");
    expect(html).toContain("<pre");
    expect(html).toContain("# not-a-heading");
  });

  test("renders function response text in a code-style pre block", () => {
    const html = render([
      {
        kind: "function_response",
        label: "Tool result (call-1)",
        role: "tool",
        toolName: "call-1",
        text: "**raw output**",
        data: null,
      },
    ]);

    expect(html).not.toContain("<strong");
    expect(html).toContain("<pre");
  });
});
