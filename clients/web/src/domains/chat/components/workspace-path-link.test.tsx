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

// Toggled per-test rather than re-mocked: `mock.module` is process-global, so
// a second registration would leak into the rest of the file.
let orgReady = true;
mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => orgReady,
}));

import { ChatMarkdownMessage } from "@/domains/chat/components/chat-markdown-message";
import { workspaceTreeQueryOptions } from "@/lib/workspace-tree-query";
import { useViewerStore } from "@/stores/viewer-store";

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
    workspaceTreeQueryOptions({ assistantId: ASSISTANT_ID, path: dir })
      .queryKey,
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
  orgReady = true;
  // A resolved span opens the real drawer, so each test starts from a closed
  // one.
  useViewerStore.getState().reset();
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

  test("clicking opens the file in the drawer, like an explicit link", () => {
    const queryClient = clientWithListing("drafts", [entry("drafts/deck.pdf")]);
    const { onVellumLinkClick } = renderMessage(
      "See `/workspace/drafts/deck.pdf`.",
      queryClient,
    );

    screen.getByRole("button", { name: "/workspace/drafts/deck.pdf" }).click();

    expect(useViewerStore.getState().openedDocumentState).toEqual({
      source: "workspace-file-preview",
      workspacePath: "drafts/deck.pdf",
      documentName: "deck.pdf",
      previewKind: "pdf",
    });
    expect(onVellumLinkClick).not.toHaveBeenCalled();
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
      workspaceTreeQueryOptions({ assistantId: ASSISTANT_ID, path: "drafts" })
        .queryKey,
      { path: "drafts", entries: [entry("drafts/notes.md")] },
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "/workspace/drafts/notes.md" }),
      ).toBeTruthy();
    });
  });

  test("no listing is requested before the organization store is ready", () => {
    // Platform-hosted requests carry an org header the store supplies after
    // auth; firing first is rejected, and `retry: false` would strand the
    // span. Cached data still renders — the gate withholds the request, not
    // the result.
    orgReady = false;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    renderMessage("See `/workspace/drafts/notes.md`.", queryClient);

    const { queryKey } = workspaceTreeQueryOptions({
      assistantId: ASSISTANT_ID,
      path: "drafts",
    });
    expect(queryClient.getQueryState(queryKey)?.fetchStatus ?? "idle").toBe(
      "idle",
    );
    expect(screen.queryByRole("button")).toBeNull();
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
