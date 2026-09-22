/**
 * Integration tests for in-app markdown hrefs rendered through
 * ChatMarkdownMessage. Conversation and schedule destinations navigate in
 * place; workspace file paths stay file links.
 */

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

import { ChatMarkdownMessage } from "@/domains/chat/components/chat-markdown-message";

describe("ChatMarkdownMessage (in-app path links)", () => {
  test("a conversation href navigates in place instead of as a file link", () => {
    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: ["/assistant"] },
        createElement(ChatMarkdownMessage, {
          content: "[Project Launch](/assistant/conversations/conv-xyz)",
        }),
      ),
    );

    expect(html).toContain('href="/assistant/conversations/conv-xyz"');
    expect(html).not.toContain('target="_blank"');
    expect(html).toContain("Project Launch");
  });

  test("a schedule href navigates in place", () => {
    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: ["/assistant"] },
        createElement(ChatMarkdownMessage, {
          content: "[Morning Briefing](/assistant/schedules/schedule-1)",
        }),
      ),
    );

    expect(html).toContain('href="/assistant/schedules/schedule-1"');
    expect(html).not.toContain('target="_blank"');
  });

  test("a vellum.ai conversation URL becomes an in-app path", () => {
    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: ["/assistant"] },
        createElement(ChatMarkdownMessage, {
          content:
            "[Project Launch](https://www.vellum.ai/assistant/conversations/conv-xyz)",
        }),
      ),
    );

    expect(html).toContain('href="/assistant/conversations/conv-xyz"');
    expect(html).not.toContain('target="_blank"');
  });

  test("a workspace file path stays a file link", () => {
    const html = renderToStaticMarkup(
      createElement(ChatMarkdownMessage, {
        content: "[notes](/workspace/scratch/notes.md)",
      }),
    );

    expect(html).toContain('href="/workspace/scratch/notes.md"');
  });
});
