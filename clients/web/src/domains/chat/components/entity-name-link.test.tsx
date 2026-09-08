/**
 * Integration tests for in-app markdown links and auto-linked conversation /
 * schedule names rendered through ChatMarkdownMessage.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

import { ChatMarkdownMessage } from "@/domains/chat/components/chat-markdown-message";
import { FOREGROUND_FILTER } from "@/utils/conversation-list-keys";
import { conversationListOptions } from "@/utils/conversation-list-options";
import { listPage } from "@/utils/conversation-list.test-helper";
import { schedulesListQueryOptions } from "@/utils/schedules";

const ASSISTANT_ID = "assistant-1";

afterEach(() => {
  cleanup();
});

function clientWithEntities(): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(
    conversationListOptions(ASSISTANT_ID, FOREGROUND_FILTER).queryKey,
    listPage([{ conversationId: "conv-xyz", title: "Project Launch" }]),
  );
  queryClient.setQueryData(schedulesListQueryOptions(ASSISTANT_ID).queryKey, [
    { id: "schedule-1", name: "Morning Briefing" },
  ]);
  return queryClient;
}

function renderMessage(
  content: string,
  queryClient: QueryClient,
  entityNameLinks = true,
) {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(
      MemoryRouter,
      { initialEntries: ["/assistant/conversations/other"] },
      createElement(QueryClientProvider, { client: queryClient }, children),
    );
  return render(
    createElement(ChatMarkdownMessage, {
      content,
      assistantId: ASSISTANT_ID,
      entityNameLinks,
    }),
    { wrapper },
  );
}

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

describe("ChatMarkdownMessage (entity name links)", () => {
  test("unique schedule and conversation names become in-app links", () => {
    renderMessage(
      "I created the Morning Briefing schedule and filed it under Project Launch.",
      clientWithEntities(),
    );

    expect(
      screen.getByRole("link", { name: "Morning Briefing" }).getAttribute(
        "href",
      ),
    ).toBe("/assistant/schedules/schedule-1");
    expect(
      screen.getByRole("link", { name: "Project Launch" }).getAttribute("href"),
    ).toBe("/assistant/conversations/conv-xyz");
  });

  test("an inline-code span that is exactly a unique name becomes a link", () => {
    renderMessage("See `Morning Briefing` for the cadence.", clientWithEntities());

    expect(
      screen.getByRole("link", { name: "Morning Briefing" }).getAttribute(
        "href",
      ),
    ).toBe("/assistant/schedules/schedule-1");
  });

  test("a fenced code block does not auto-link names", () => {
    renderMessage(
      "```\nMorning Briefing\n```",
      clientWithEntities(),
    );

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Morning Briefing")).toBeTruthy();
  });

  test("an explicit markdown link is not wrapped again", () => {
    renderMessage(
      "[Morning Briefing](/assistant/schedules/schedule-1)",
      clientWithEntities(),
    );

    const links = screen.getAllByRole("link", { name: "Morning Briefing" });
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe(
      "/assistant/schedules/schedule-1",
    );
  });

  test("user-authored markdown does not auto-link names", () => {
    renderMessage(
      "Please open Morning Briefing",
      clientWithEntities(),
      false,
    );

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/Morning Briefing/)).toBeTruthy();
  });

  test("a colliding title stays plain text", () => {
    const queryClient = clientWithEntities();
    queryClient.setQueryData(
      conversationListOptions(ASSISTANT_ID, FOREGROUND_FILTER).queryKey,
      listPage([
        { conversationId: "conv-xyz", title: "Morning Briefing" },
        { conversationId: "conv-abc", title: "Other Chat" },
      ]),
    );

    renderMessage("See Morning Briefing and Other Chat later.", queryClient);

    expect(screen.queryByRole("link", { name: "Morning Briefing" })).toBeNull();
    expect(
      screen.getByRole("link", { name: "Other Chat" }).getAttribute("href"),
    ).toBe("/assistant/conversations/conv-abc");
  });
});
