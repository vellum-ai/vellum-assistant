/**
 * Tests for `SingleActivity variant="web"` — the inline lone-web link.
 *
 * Verifies the inline "Web Search | <info/carousel>" link:
 *  - renders the `inline-web-link` "Web Search | <info/carousel>"
 *  - collapsed hides the favicon result row
 *  - `expanded` reveals the `WebSearchStepRow` favicons
 *  - a `web_search_error` step renders the error row
 *  - state drives the leading indicator / negative tone
 *  - null step (loading) renders expanded body empty without crashing
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, fireEvent, render } from "@testing-library/react";

import { SingleActivity } from "@/domains/chat/components/single-activity/single-activity";
import type { ToolCallCardStep } from "@/domains/chat/utils/tool-call-card-utils";
import type { WebSearchResultItem } from "@/assistant/web-activity-types";

afterEach(() => {
  cleanup();
});

function makeResult(
  i: number,
  overrides: Partial<WebSearchResultItem> = {},
): WebSearchResultItem {
  return {
    rank: i,
    title: `Result ${i}`,
    url: `https://example-${i}.test/`,
    domain: `example-${i}.test`,
    faviconUrl: `https://example-${i}.test/favicon.ico`,
    ...overrides,
  };
}

const WEB_STEP: Extract<ToolCallCardStep, { kind: "web_search" }> = {
  kind: "web_search",
  title: "Searched the web",
  durationLabel: "1s",
  linkCount: 2,
  results: [makeResult(1), makeResult(2)],
};

const ERROR_STEP: Extract<ToolCallCardStep, { kind: "web_search_error" }> = {
  kind: "web_search_error",
  title: "Web search failed",
  durationLabel: "1s",
  errorMessage: "Provider returned max_uses_exceeded.",
};

describe("SingleActivity variant='web' — inline lone-web link", () => {
  test("renders the inline 'Web Search | <info>' link", () => {
    const { getByTestId, getByText } = render(
      <SingleActivity
        variant="web"
        info="Result 2"
        carouselItems={[]}
        state="complete"
        step={WEB_STEP}
        expanded={false}
        onExpandChange={() => {}}
      />,
    );
    expect(getByTestId("inline-web-link")).toBeTruthy();
    expect(getByText("Web Search")).toBeTruthy();
    expect(getByText("Result 2")).toBeTruthy();
  });

  test("collapsed hides the favicon result row", () => {
    const { queryByText } = render(
      <SingleActivity
        variant="web"
        info="Result 2"
        carouselItems={[]}
        state="complete"
        step={WEB_STEP}
        expanded={false}
        onExpandChange={() => {}}
      />,
    );
    // carouselItems is empty, so the favicon labels can only come from the
    // expanded step row — collapsed they must not render.
    expect(queryByText("Result 1")).toBeNull();
  });

  test("expanded reveals the WebSearchStepRow favicons", () => {
    const { getByText } = render(
      <SingleActivity
        variant="web"
        info="latest result"
        carouselItems={[]}
        state="complete"
        step={WEB_STEP}
        expanded
        onExpandChange={() => {}}
      />,
    );
    // carouselItems is empty, so the favicon labels can only come from the
    // expanded step row.
    expect(getByText("Result 1")).toBeTruthy();
    expect(getByText("Result 2")).toBeTruthy();
  });

  test("clicking the link toggles via onExpandChange", () => {
    let next: boolean | undefined;
    const { getByTestId } = render(
      <SingleActivity
        variant="web"
        info="Result 2"
        carouselItems={[]}
        state="complete"
        step={WEB_STEP}
        expanded={false}
        onExpandChange={(v) => {
          next = v;
        }}
      />,
    );
    fireEvent.click(getByTestId("inline-web-link"));
    expect(next).toBe(true);
  });

  test("loading state renders the three-dot indicator", () => {
    const { getByTestId } = render(
      <SingleActivity
        variant="web"
        info="my query"
        carouselItems={[]}
        state="loading"
        step={WEB_STEP}
        expanded={false}
        onExpandChange={() => {}}
      />,
    );
    expect(getByTestId("inline-web-loading")).toBeTruthy();
  });

  test("a web_search_error step renders the error row when expanded", () => {
    const { getByTestId, getByText } = render(
      <SingleActivity
        variant="web"
        info=""
        carouselItems={[]}
        state="error"
        step={ERROR_STEP}
        expanded
        onExpandChange={() => {}}
      />,
    );
    expect(getByTestId("web-search-error-chip")).toBeTruthy();
    expect(getByText("Provider returned max_uses_exceeded.")).toBeTruthy();
  });

  test("error state applies the negative tone to the inline link", () => {
    const { getByTestId } = render(
      <SingleActivity
        variant="web"
        info=""
        carouselItems={[]}
        state="error"
        step={ERROR_STEP}
        expanded={false}
        onExpandChange={() => {}}
      />,
    );
    expect(getByTestId("inline-web-link").className).toContain(
      "text-[var(--system-negative-strong)]",
    );
  });

  test("null step (loading) renders expanded body empty without crashing", () => {
    const { getByTestId, queryByText } = render(
      <SingleActivity
        variant="web"
        info=""
        carouselItems={[]}
        state="loading"
        step={null}
        expanded
        onExpandChange={() => {}}
      />,
    );
    // The inline link still renders (the header is visible regardless of step).
    expect(getByTestId("inline-web-link")).toBeTruthy();
    // But the expanded body is empty — no crash, no result text.
    expect(queryByText("Result 1")).toBeNull();
  });
});
