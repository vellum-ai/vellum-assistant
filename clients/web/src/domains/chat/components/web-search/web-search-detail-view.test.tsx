/**
 * Tests for `WebSearchDetailView` — the nested detail shown when a subagent
 * "Searching the web" query pill is clicked. Covers the query line + the
 * source chips, and the empty-results fallback.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, render } from "@testing-library/react";

import { WebSearchDetailView } from "@/domains/chat/components/web-search/web-search-detail-view";
import type { ToolDetailPayload } from "@/stores/viewer-store";

afterEach(() => {
  cleanup();
});

function payload(overrides: Partial<ToolDetailPayload>): ToolDetailPayload {
  return {
    toolCallId: "tu-ws",
    toolName: "web_search",
    title: "Searched the web",
    activity: "",
    input: {},
    status: "completed",
    kind: "web_search",
    ...overrides,
  };
}

describe("WebSearchDetailView", () => {
  test("renders the query verbatim and one source chip per result", () => {
    const { getByText, getAllByTestId } = render(
      <WebSearchDetailView
        detail={payload({
          searchQuery: "best vector databases",
          searchResults: [
            { rank: 1, title: "First", url: "https://a.com/x", domain: "a.com" },
            { rank: 2, title: "Second", url: "https://b.org/y", domain: "b.org" },
          ],
        })}
      />,
    );

    // Query rendered verbatim (in quotes) above the source list.
    expect(getByText('"best vector databases"')).toBeTruthy();
    expect(getByText("Sources (2)")).toBeTruthy();

    // Each source renders as the same external-link favicon chip the timeline
    // uses (an anchor, variant "web").
    const chips = getAllByTestId("tool-step-pill");
    expect(chips.length).toBe(2);
    chips.forEach((chip) => expect(chip.tagName).toBe("A"));
    expect(chips[0]!.getAttribute("href")).toBe("https://a.com/x");
    expect(chips[0]!.textContent).toContain("First");
  });

  test("shows an empty-state message when the search returned no sources", () => {
    const { getByText, queryByTestId } = render(
      <WebSearchDetailView
        detail={payload({ searchQuery: "obscure query", searchResults: [] })}
      />,
    );

    expect(getByText("Sources")).toBeTruthy();
    expect(getByText("No sources found.")).toBeTruthy();
    expect(queryByTestId("tool-step-pill")).toBeNull();
  });
});
