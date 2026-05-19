/**
 * Tests for PromptTab.
 *
 * The web workspace doesn't load a DOM testing library, so we render to
 * static markup via `react-dom/server` and assert on the resulting HTML.
 * This is sufficient to verify the new view-mode toggle, markdown-by-
 * default rendering, and structured (JSON) sections that ignore the toggle.
 */

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { LLMRequestLogEntry } from "@/domains/chat/lib/inspector-types.js";

import { PromptTab } from "@/components/app/assistant/message-inspector/tabs/prompt-tab.js";

function makeEntry(
  overrides: Partial<LLMRequestLogEntry> = {},
): LLMRequestLogEntry {
  return {
    id: "log-1",
    createdAt: 1_715_200_000_000,
    requestPayload: null,
    responsePayload: null,
    summary: null,
    requestSections: [],
    responseSections: [],
    ...overrides,
  };
}

describe("PromptTab", () => {
  test("shows the Markdown / Raw toggle when sections exist", () => {
    const entry = makeEntry({
      requestSections: [
        {
          kind: "system",
          label: "System prompt",
          text: "# Header\n\nBody",
          language: null,
        },
      ],
    });

    const html = renderToStaticMarkup(createElement(PromptTab, { entry }));

    expect(html).toContain("Prompt rendering mode");
    expect(html).toContain(">Markdown</");
    expect(html).toContain(">Raw</");
  });

  test("hides the toggle when there are no sections", () => {
    const entry = makeEntry({ requestSections: [] });

    const html = renderToStaticMarkup(createElement(PromptTab, { entry }));

    expect(html).not.toContain("Prompt rendering mode");
    expect(html).toContain("No normalized prompt sections");
  });

  test("renders text sections as markdown by default", () => {
    const entry = makeEntry({
      requestSections: [
        {
          kind: "system",
          label: "System prompt",
          text: "# Heading One\n\nParagraph **bold**.",
          language: null,
        },
      ],
    });

    const html = renderToStaticMarkup(createElement(PromptTab, { entry }));

    // Heading is parsed by react-markdown into a real <h1>
    expect(html).toContain("<h1");
    expect(html).toContain("Heading One");
    // Bold inline runs through to <strong>
    expect(html).toContain("<strong");
  });

  test("structured JSON sections always render as <pre>, not markdown", () => {
    const entry = makeEntry({
      requestSections: [
        {
          kind: "tools",
          label: "Tools",
          data: { tools: ["foo", "bar"] },
          language: "application/json",
        },
      ],
    });

    const html = renderToStaticMarkup(createElement(PromptTab, { entry }));

    expect(html).toContain("<pre");
    expect(html).toContain("&quot;tools&quot;");
    // No markdown heading parsing on JSON data.
    expect(html).not.toContain("<h1");
  });

  test("text sections include break-words guard against ultra-long tokens", () => {
    const entry = makeEntry({
      requestSections: [
        {
          kind: "user",
          label: "User",
          text: "a-long-line",
          language: null,
        },
      ],
    });

    const html = renderToStaticMarkup(createElement(PromptTab, { entry }));

    expect(html).toContain("break-words");
  });

  test("preserves leading `---` frontmatter blocks in section text", () => {
    // Prompt sections legitimately begin with a `---\nrole: system\n---\n`
    // fence — stripping it would silently truncate the section. Regression
    // guard for the `stripFrontmatter={false}` wiring.
    const entry = makeEntry({
      requestSections: [
        {
          kind: "system",
          label: "System prompt",
          text: "---\nrole: system\n---\n\nReal body content here.",
          language: null,
        },
      ],
    });

    const html = renderToStaticMarkup(createElement(PromptTab, { entry }));

    expect(html).toContain("role: system");
    expect(html).toContain("Real body content here.");
  });
});
