/**
 * Integration tests for workspace-path spans rendered through
 * ChatMarkdownMessage.
 *
 * The listing query is seeded directly into the TanStack cache rather than
 * mocked at the SDK layer: the cache entry is the contract the component
 * actually reads, and seeding it keeps the assertions about *existence
 * gating* (the point of the feature) instead of fetch plumbing.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import { ChatMarkdownMessage } from "@/domains/chat/components/chat-markdown-message";
import { workspaceTreeGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";

const ASSISTANT_ID = "assistant-1";

interface TreeEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number | null;
  mimeType: string | null;
  modifiedAt: string;
}

function entry(path: string, type: "file" | "directory" = "file"): TreeEntry {
  return {
    name: path.split("/").pop() ?? path,
    path,
    type,
    size: 128,
    mimeType: "text/markdown",
    modifiedAt: "2026-07-24T02:18:49Z",
  };
}

/** Seed the directory listing the component will read for `dir`. */
function clientWithListing(dir: string, entries: TreeEntry[]): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(
    workspaceTreeGetQueryKey({
      path: { assistant_id: ASSISTANT_ID },
      query: { path: dir },
    }),
    { path: dir, entries },
  );
  return queryClient;
}

function renderMessage(
  content: string,
  queryClient: QueryClient,
  {
    workspacePathLinks = true,
    onVellumLinkClick = mock(() => {}),
  }: {
    workspacePathLinks?: boolean;
    onVellumLinkClick?: (href: string, linkText: string) => void;
  } = {},
) {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  render(
    createElement(ChatMarkdownMessage, {
      content,
      assistantId: ASSISTANT_ID,
      workspacePathLinks,
      onVellumLinkClick,
    }),
    { wrapper },
  );
  return { onVellumLinkClick };
}

afterEach(() => {
  cleanup();
});

describe("workspace path spans", () => {
  test("a path whose file exists renders as a clickable link", () => {
    const queryClient = clientWithListing("drafts", [
      entry("drafts/v0.10.12-release-notes.md"),
    ]);
    renderMessage(
      "The draft is at `/workspace/drafts/v0.10.12-release-notes.md`.",
      queryClient,
    );

    const button = screen.getByRole("button", {
      name: "/workspace/drafts/v0.10.12-release-notes.md",
    });
    expect(button).toBeTruthy();
  });

  test("clicking opens the file-action modal with the vellum:// href", () => {
    const queryClient = clientWithListing("drafts", [entry("drafts/notes.md")]);
    const { onVellumLinkClick } = renderMessage(
      "See `/workspace/drafts/notes.md`.",
      queryClient,
    );

    screen.getByRole("button", { name: "/workspace/drafts/notes.md" }).click();

    expect(onVellumLinkClick).toHaveBeenCalledWith(
      "vellum://workspace/drafts/notes.md",
      "notes.md",
    );
  });

  test("a path whose file does not exist stays plain code", () => {
    // The "I'll write it to X" case: the span is path-shaped, but nothing is
    // there yet. A link here would be dead on arrival.
    const queryClient = clientWithListing("drafts", [entry("drafts/other.md")]);
    renderMessage(
      "I'll write it to `/workspace/drafts/notes.md`.",
      queryClient,
    );

    expect(screen.queryByRole("button")).toBeNull();
    expect(
      screen.getByText("/workspace/drafts/notes.md").tagName.toLowerCase(),
    ).toBe("code");
  });

  test("a directory entry does not become a file link", () => {
    const queryClient = clientWithListing("drafts", [
      entry("drafts/archive", "directory"),
    ]);
    renderMessage("Look in `/workspace/drafts/archive`.", queryClient);

    expect(screen.queryByRole("button")).toBeNull();
  });

  test("an unresolved listing stays plain code", () => {
    // No cache entry: the query is still in flight (or failed). Nothing is
    // rendered as a link until the file is confirmed.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, enabled: false } },
    });
    renderMessage("See `/workspace/drafts/notes.md`.", queryClient);

    expect(screen.queryByRole("button")).toBeNull();
    expect(
      screen.getByText("/workspace/drafts/notes.md").tagName.toLowerCase(),
    ).toBe("code");
  });

  test("user-authored content is never upgraded", () => {
    // A path the user typed is their own prose — it renders as written even
    // when the file exists.
    const queryClient = clientWithListing("drafts", [entry("drafts/notes.md")]);
    renderMessage("See `/workspace/drafts/notes.md`.", queryClient, {
      workspacePathLinks: false,
    });

    expect(screen.queryByRole("button")).toBeNull();
  });

  test("a file that appears later upgrades the span in place", async () => {
    // The "I'll write it to X, ... wrote it to X" sequence: the listing is
    // cached before the file exists, and the span must pick up the refreshed
    // listing without being remounted.
    const queryClient = clientWithListing("drafts", []);
    renderMessage(
      "I'll write it to `/workspace/drafts/notes.md`.",
      queryClient,
    );

    expect(screen.queryByRole("button")).toBeNull();

    queryClient.setQueryData(
      workspaceTreeGetQueryKey({
        path: { assistant_id: ASSISTANT_ID },
        query: { path: "drafts" },
      }),
      { path: "drafts", entries: [entry("drafts/notes.md")] },
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "/workspace/drafts/notes.md" }),
      ).toBeTruthy();
    });
  });

  test("paths inside fenced code blocks are left alone", () => {
    const queryClient = clientWithListing("drafts", [entry("drafts/notes.md")]);
    renderMessage("```\n/workspace/drafts/notes.md\n```", queryClient);

    // Scoped by name: the code block ships its own copy button.
    expect(
      screen.queryByRole("button", { name: "/workspace/drafts/notes.md" }),
    ).toBeNull();
  });
});
