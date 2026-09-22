/**
 * Tests for `WebSearchDetailView`, the body of a web search in every tool
 * detail: the query, the source chips, and what it says when there are no
 * sources (still running, refused, failed, or finished with none).
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, render } from "@testing-library/react";

import { WebSearchDetailView } from "@/domains/chat/components/web-search/web-search-detail-view";
import type { ToolDetailPayload } from "@/stores/viewer-store";

afterEach(() => {
  cleanup();
});

type ViewProps = Parameters<typeof WebSearchDetailView>[0];

/** The view as the renderer registry renders it, settled unless overridden. */
function renderView(
  detail: ToolDetailPayload,
  overrides: Partial<Omit<ViewProps, "detail">> = {},
) {
  return render(
    <WebSearchDetailView
      detail={detail}
      result={undefined}
      activityMetadata={undefined}
      streamedOutput={undefined}
      answeredQuestion={undefined}
      isRunning={false}
      isError={false}
      isDenied={false}
      {...overrides}
    />,
  );
}

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
    const { getByText, getAllByTestId } = renderView(
      payload({
        searchQuery: "best vector databases",
        searchResults: [
          {
            rank: 1,
            title: "First",
            url: "https://a.com/x",
            domain: "a.com",
          },
          {
            rank: 2,
            title: "Second",
            url: "https://b.org/y",
            domain: "b.org",
          },
        ],
      }),
    );

    // The query as written, above the source list.
    expect(getByText("best vector databases")).toBeTruthy();
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
    const { getByText, queryByTestId } = renderView(
      payload({ searchQuery: "obscure query", searchResults: [] }),
    );

    expect(getByText("Sources")).toBeTruthy();
    expect(getByText("No sources found.")).toBeTruthy();
    expect(queryByTestId("tool-step-pill")).toBeNull();
  });

  test("says a search still running is running, not that it found nothing", () => {
    const { getByTestId, queryByText } = renderView(
      payload({ searchQuery: "pending query", status: "running" }),
      { isRunning: true },
    );

    expect(getByTestId("tool-output-notice").textContent).toBe("Running…");
    expect(queryByText("No sources found.")).toBeNull();
  });

  test("says a refused search did not run, never its note to the model", () => {
    const { getByTestId, queryByText } = renderView(
      payload({ searchQuery: "refused query", status: "denied" }),
      {
        isDenied: true,
        isError: true,
        result: "Permission denied. Do NOT retry this tool call.",
      },
    );

    expect(getByTestId("tool-output-notice").textContent).toBe(
      "This tool call was not approved, so it did not run.",
    );
    expect(queryByText("No sources found.")).toBeNull();
    expect(queryByText(/Do NOT retry/)).toBeNull();
  });

  test("shows the error of a search that fails while open", () => {
    const { getByText, queryByText } = renderView(
      payload({ searchQuery: "failing query", status: "running" }),
      { isError: true, result: "Search provider unavailable." },
    );

    expect(getByText("Search provider unavailable.")).toBeTruthy();
    expect(queryByText("No sources found.")).toBeNull();
  });
});
