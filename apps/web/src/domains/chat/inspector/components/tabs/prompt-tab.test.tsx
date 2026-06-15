/**
 * Tests for the PromptTab section rendering. Renders to static markup
 * (no DOM), mirroring `compaction-tab.test.tsx`, and asserts that prose
 * sections (system prompt, user and assistant messages) render as Markdown
 * while structured payloads, tool-call arguments, and tool results render as
 * code-style `<pre>` text. Literal `<tag>`-style prompt delimiters stay
 * visible as text.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

function render(sections: LLMContextSection[]): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <PromptTab
        entry={makeEntry(sections)}
        previous={null}
        assistantId={undefined}
      />
    </QueryClientProvider>,
  );
}

describe("PromptTab", () => {
  test("renders text sections as Markdown", () => {
    const html = render([
      {
        kind: "message",
        label: "User message 1",
        role: "user",
        toolName: null,
        text: "# Heading\n\n**bold** prose",
        data: null,
      },
    ]);

    // Markdown syntax is formatted: the heading and emphasis become real
    // elements rather than literal `#`/`**` characters.
    expect(html).toContain("<h1");
    expect(html).toContain("Heading");
    expect(html).toContain("<strong");
  });

  test("preserves XML-style prompt delimiters as literal text", () => {
    const html = render([
      {
        kind: "system",
        label: "System prompt",
        role: "system",
        toolName: null,
        text: "<instructions>\nFollow these rules.\n</instructions>",
        data: null,
      },
    ]);

    expect(html).toContain("&lt;instructions&gt;");
    expect(html).toContain("Follow these rules.");
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

  test("renders tool-call arguments in a code-style pre block, not Markdown", () => {
    // Tool-call sections carry a JSON preview in `text` alongside the
    // structured `data` args. Markdown rendering would mangle JSON tokens
    // (e.g. `**` becomes bold), so they must render as raw `<pre>`.
    const html = render([
      {
        kind: "function_call",
        label: "Request tool call (read_file)",
        role: "assistant",
        toolName: "read_file",
        text: '{"path":"/tmp/a","note":"**keep raw**"}',
        data: { path: "/tmp/a", note: "**keep raw**" },
      },
    ]);

    expect(html).not.toContain("<strong");
    expect(html).toContain("<pre");
    expect(html).toContain("**keep raw**");
  });
});
