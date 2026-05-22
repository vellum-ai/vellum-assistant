/**
 * Tests for `WebSearchProgressCard`.
 *
 * Uses the project's `@testing-library/react` (react-testing-library + bun:test). The
 * card itself is purely presentational; the suite exercises:
 *  - collapsed → expanded toggling via the step-count pill
 *  - rendering of both `thinking` and `web_search` step descriptors
 *  - the `+N more` overflow chip
 *  - the animated step-carousel header (title + info tuple) with the 400ms
 *    minimum-dwell throttle, last-value-wins coalescing, and the reduced-
 *    motion fallback
 *  - the `data-testid` hook used by integration tests
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { act } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";

import {
  WebSearchProgressCard,
  type StepDescriptor,
} from "@/domains/chat/components/web-search/web-search-progress-card.js";
import type { WebSearchResultItem } from "@/assistant/web-activity-types.js";

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

const TWO_THINKING_STEPS: StepDescriptor[] = [
  { kind: "thinking", durationLabel: "1s", text: "Forming a query" },
  { kind: "thinking", durationLabel: "2s", text: "Picking sources" },
];

describe("WebSearchProgressCard — collapsed state", () => {
  test("renders the header but no step rows by default", () => {
    const { queryByText, getByText } = render(
      <WebSearchProgressCard
        currentStepTitle="Searching the web"
        currentStepInfo="my query"
        stepCount="2 steps"
        steps={TWO_THINKING_STEPS}
      />,
    );
    expect(getByText("Searching the web")).toBeTruthy();
    expect(getByText("2 steps")).toBeTruthy();
    // No StepRow content rendered while collapsed.
    expect(queryByText("Forming a query")).toBeNull();
    expect(queryByText("Picking sources")).toBeNull();
  });

  test("clicking the header label expands the card (whole row is clickable)", () => {
    // The entire header row is now the toggle — not just the step-count
    // pill. Clicking the title text should expand because the surrounding
    // Button receives the click via event bubbling.
    const { getByText, queryByText } = render(
      <WebSearchProgressCard
        currentStepTitle="Searching the web"
        currentStepInfo="my query"
        stepCount="2 steps"
        steps={TWO_THINKING_STEPS}
      />,
    );
    expect(queryByText("Forming a query")).toBeNull();
    fireEvent.click(getByText("Searching the web"));
    expect(getByText("Forming a query")).toBeTruthy();
    expect(getByText("Picking sources")).toBeTruthy();
  });

  test("clicking the status-indicator dots also toggles the card", () => {
    // Bubbling check: a click on the ThreeDotIndicator (inside the header
    // Button) should reach the Button's onClick.
    const { getByTestId, getByText, queryByText } = render(
      <WebSearchProgressCard
        currentStepTitle="Searching the web"
        currentStepInfo="my query"
        stepCount="2 steps"
        steps={TWO_THINKING_STEPS}
      />,
    );
    expect(queryByText("Forming a query")).toBeNull();
    fireEvent.click(getByTestId("web-search-status-indicator"));
    expect(getByText("Forming a query")).toBeTruthy();
  });

  test("clicking the step-count pill still expands the card", () => {
    // The pill is now a visual-only span inside the header Button, but
    // clicks on it should still bubble up and toggle.
    const { getByText, queryByText } = render(
      <WebSearchProgressCard
        currentStepTitle="Searching the web"
        currentStepInfo="my query"
        stepCount="2 steps"
        steps={TWO_THINKING_STEPS}
      />,
    );
    expect(queryByText("Forming a query")).toBeNull();
    fireEvent.click(getByText("2 steps"));
    expect(getByText("Forming a query")).toBeTruthy();
  });

  test("renders the currentStepInfo subtext alongside the title in collapsed mode", () => {
    // The collapsed header now shows the animated title + info row directly
    // (no separate WebsiteCarousel) — info text should be present on mount.
    const { getByText } = render(
      <WebSearchProgressCard
        currentStepTitle="Searching the web"
        currentStepInfo="Tigers — Wikipedia"
        stepCount="2 steps"
        steps={TWO_THINKING_STEPS}
      />,
    );
    expect(getByText("Tigers — Wikipedia")).toBeTruthy();
    expect(getByText("Searching the web")).toBeTruthy();
  });

  test("renders WebsiteCarousel in the info slot when carouselItems are provided in loading state", () => {
    // Carousel mode supersedes the text info slot — `currentStepInfo` is not
    // rendered, the carousel's current item title is.
    const items: WebSearchResultItem[] = [
      makeResult(1, { title: "Sotheby's — Auctions" }),
    ];
    const { getByText, queryByText } = render(
      <WebSearchProgressCard
        currentStepTitle="Searching the web"
        currentStepInfo="should be hidden"
        stepCount="2 steps"
        steps={TWO_THINKING_STEPS}
        state="loading"
        carouselItems={items}
      />,
    );
    expect(getByText("Searching the web")).toBeTruthy();
    expect(getByText("Sotheby's — Auctions")).toBeTruthy();
    expect(queryByText("should be hidden")).toBeNull();
  });

  test("falls back to text mode when carouselItems is empty", () => {
    const { getByText } = render(
      <WebSearchProgressCard
        currentStepTitle="Searching the web"
        currentStepInfo="Tigers — Wikipedia"
        stepCount="2 steps"
        steps={TWO_THINKING_STEPS}
        state="loading"
        carouselItems={[]}
      />,
    );
    expect(getByText("Tigers — Wikipedia")).toBeTruthy();
  });

  test("does not render the carousel in complete state even with items", () => {
    // Complete state is the resting visual — the user-facing label should be
    // the final result title, not a still-rotating carousel.
    const items: WebSearchResultItem[] = [
      makeResult(1, { title: "Sotheby's — Auctions" }),
    ];
    const { getByText, queryByText } = render(
      <WebSearchProgressCard
        currentStepTitle="Searched the web"
        currentStepInfo="Final result title"
        stepCount="2 steps"
        steps={TWO_THINKING_STEPS}
        state="complete"
        carouselItems={items}
      />,
    );
    expect(getByText("Final result title")).toBeTruthy();
    expect(queryByText("Sotheby's — Auctions")).toBeNull();
  });
});

describe("WebSearchProgressCard — expanded state", () => {
  test("renders both thinking and web_search rows when expanded by default", () => {
    const steps: StepDescriptor[] = [
      { kind: "thinking", durationLabel: "1s", text: "Forming a query" },
      {
        kind: "web_search",
        title: "Searching the web",
        durationLabel: "2s",
        linkCount: 2,
        results: [makeResult(1), makeResult(2)],
      },
    ];
    const { getByText, getAllByText, container } = render(
      <WebSearchProgressCard
        currentStepTitle="Searching the web"
        currentStepInfo="my query"
        stepCount="2 steps"
        steps={steps}
        defaultExpanded
      />,
    );
    // Thinking row renders its text via ThinkingChip.
    expect(getByText("Forming a query")).toBeTruthy();
    // "Searching the web" appears in both header + the web_search StepRow title.
    expect(getAllByText("Searching the web")).toHaveLength(2);
    // web_search row meta cluster ("{n} links" + duration).
    expect(getByText("2 links")).toBeTruthy();
    expect(getByText("2s")).toBeTruthy();
    expect(getByText("1s")).toBeTruthy();
    // Each result rendered a FaviconChip.
    expect(getByText("Result 1")).toBeTruthy();
    expect(getByText("Result 2")).toBeTruthy();
    // Two favicons → two <img>s.
    expect(container.querySelectorAll("img")).toHaveLength(2);
  });

  test("renders the +N more overflow chip after results", () => {
    const steps: StepDescriptor[] = [
      {
        kind: "web_search",
        title: "Searching the web",
        durationLabel: "2s",
        linkCount: 5,
        results: [makeResult(1), makeResult(2)],
        overflow: 3,
      },
    ];
    const { getByText } = render(
      <WebSearchProgressCard
        currentStepTitle="Searching the web"
        currentStepInfo="my query"
        stepCount="1 step"
        steps={steps}
        defaultExpanded
      />,
    );
    expect(getByText("+3 more")).toBeTruthy();
  });

  test("singularizes the link count in the meta cluster when linkCount === 1", () => {
    const steps: StepDescriptor[] = [
      {
        kind: "web_search",
        title: "Searching the web",
        durationLabel: "1s",
        linkCount: 1,
        results: [makeResult(1)],
      },
    ];
    const { getByText, queryByText } = render(
      <WebSearchProgressCard
        currentStepTitle="Searching the web"
        currentStepInfo="my query"
        stepCount="1 step"
        steps={steps}
        defaultExpanded
      />,
    );
    expect(getByText("1 link")).toBeTruthy();
    // No stray plural variant on the page.
    expect(queryByText("1 links")).toBeNull();
  });

  test("omits the overflow chip when overflow is 0 or undefined", () => {
    const steps: StepDescriptor[] = [
      {
        kind: "web_search",
        title: "Searching the web",
        durationLabel: "2s",
        linkCount: 2,
        results: [makeResult(1), makeResult(2)],
        overflow: 0,
      },
    ];
    const { queryByText } = render(
      <WebSearchProgressCard
        currentStepTitle="Searching the web"
        currentStepInfo="my query"
        stepCount="1 step"
        steps={steps}
        defaultExpanded
      />,
    );
    expect(queryByText(/\+\d+ more/)).toBeNull();
  });
});

describe("WebSearchProgressCard — header layout", () => {
  test("applies whitespace-nowrap to the header title so long subtext can't wrap the label", () => {
    // Regression: a long URL / page-title subtext was wrapping the
    // "Searched the web" label onto a second line. The label is now
    // `shrink-0 whitespace-nowrap` while the subtext container takes
    // `flex-1 min-w-0 truncate`.
    const longSubtext = "x".repeat(200);
    const { getByText } = render(
      <WebSearchProgressCard
        currentStepTitle="Searched the web"
        currentStepInfo={longSubtext}
        stepCount="2 steps"
        steps={TWO_THINKING_STEPS}
        state="complete"
        defaultExpanded
      />,
    );
    const label = getByText("Searched the web");
    expect(label.className).toContain("whitespace-nowrap");
    expect(label.className).toContain("shrink-0");
  });

  test("step-count pill stays shrink-0 so long subtext can't squeeze it", () => {
    // The pill is now a visual-only <span> inside the header Button.
    const { getByText } = render(
      <WebSearchProgressCard
        currentStepTitle="Searched the web"
        currentStepInfo={"x".repeat(200)}
        stepCount="2 steps"
        steps={TWO_THINKING_STEPS}
        state="complete"
        defaultExpanded
      />,
    );
    // The pill text lives inside a Typography <span>; the styled wrapper
    // <span> with the shrink-0 + pill chrome is its parent.
    const pillText = getByText("2 steps");
    const pillWrapper = pillText.parentElement;
    expect(pillWrapper?.className ?? "").toContain("shrink-0");
  });

  test("long header subtext truncates instead of overflowing the card", () => {
    // Regression: PR #7440 added `flex-1 min-w-0 truncate` to the subtext
    // container, but the Typography itself (default <span>, inline) was
    // missing `block` — so the truncate utility never engaged on inline
    // elements and long URLs / titles ran past the card edge.
    const longSubtext =
      "This month's blockbuster auctions in New York could bring upwards of $2.5bn — The Art Newspaper — International art news and events";
    const { getByText } = render(
      <WebSearchProgressCard
        currentStepTitle="Searched the web"
        currentStepInfo={longSubtext}
        stepCount="2 steps"
        steps={TWO_THINKING_STEPS}
        state="complete"
        defaultExpanded
      />,
    );
    const subtext = getByText(longSubtext);
    // `truncate` (overflow:hidden + text-ellipsis + nowrap) only works on a
    // block / inline-block box. The Typography default is <span> (inline),
    // so we explicitly apply `block` alongside `truncate` + `min-w-0` so the
    // ellipsis actually engages within the flex chain.
    expect(subtext.className).toContain("truncate");
    expect(subtext.className).toContain("min-w-0");
    expect(subtext.className).toContain("block");
  });

  test("the outer card wrapper spans the full content width", () => {
    // Regression: the collapsed card was rendering as a narrow shrink-to-fit
    // pill inside its parent flex column (TranscriptMessageBody uses
    // `items-start`), instead of matching the surrounding chat content width.
    // The outer wrapper must carry `w-full` so the card fills the available
    // turn-content width like the legacy `ToolCallProgressCard` does.
    const { getByTestId } = render(
      <WebSearchProgressCard
        currentStepTitle="Searched the web"
        currentStepInfo="my query"
        stepCount="2 steps"
        steps={TWO_THINKING_STEPS}
        state="complete"
      />,
    );
    const card = getByTestId("web-search-progress-card");
    expect(card.className).toContain("w-full");
  });

  test("the entire header row is a single Button (whole-row clickable)", () => {
    // Make sure there's exactly one toggle Button in the header, not a
    // separate inner pill-only Button.
    const { getAllByRole } = render(
      <WebSearchProgressCard
        currentStepTitle="Searched the web"
        currentStepInfo="my query"
        stepCount="2 steps"
        steps={TWO_THINKING_STEPS}
        state="complete"
      />,
    );
    const toggles = getAllByRole("button", { name: /expand steps/i });
    expect(toggles).toHaveLength(1);
    const toggle = toggles[0];
    if (!toggle) throw new Error("expected a header toggle button");
    // And it spans the full width so clicks land anywhere in the row.
    expect(toggle.className).toContain("w-full");
  });
});

describe("WebSearchProgressCard — error variant", () => {
  test("renders the web_search_error step with a red AlertCircle and error chip", () => {
    const steps: StepDescriptor[] = [
      {
        kind: "web_search_error",
        title: "Web search failed",
        durationLabel: "1s",
        errorMessage: "Provider returned max_uses_exceeded.",
      },
    ];
    const { getByText, getByTestId, getAllByTestId } = render(
      <WebSearchProgressCard
        currentStepTitle="Searched the web"
        currentStepInfo=""
        stepCount="1 step"
        steps={steps}
        defaultExpanded
        state="complete"
      />,
    );
    expect(getByText("Web search failed")).toBeTruthy();
    expect(
      getByText("Provider returned max_uses_exceeded."),
    ).toBeTruthy();
    expect(getByTestId("web-search-error-chip")).toBeTruthy();
    // The error row's leading icon is the AlertCircle, marked with
    // data-tone="error" so we can find it without scraping classnames.
    const statusIcons = getAllByTestId("step-row-status-icon");
    const errorIcons = statusIcons.filter(
      (el) => el.getAttribute("data-tone") === "error",
    );
    expect(errorIcons).toHaveLength(1);
  });

  test("uses the green CheckCircle2 for non-error step rows", () => {
    const steps: StepDescriptor[] = [
      {
        kind: "web_search",
        title: "Searched the web",
        durationLabel: "1s",
        linkCount: 1,
        results: [makeResult(1)],
      },
    ];
    const { getAllByTestId } = render(
      <WebSearchProgressCard
        currentStepTitle="Searched the web"
        currentStepInfo=""
        stepCount="1 step"
        steps={steps}
        defaultExpanded
        state="complete"
      />,
    );
    const statusIcons = getAllByTestId("step-row-status-icon");
    expect(statusIcons.every((el) => el.getAttribute("data-tone") === "default")).toBe(true);
  });
});

describe("WebSearchProgressCard — wrapper", () => {
  test("exposes data-testid on the outer wrapper for integration tests", () => {
    const { getByTestId } = render(
      <WebSearchProgressCard
        currentStepTitle="Searching the web"
        currentStepInfo="my query"
        stepCount="2 steps"
        steps={TWO_THINKING_STEPS}
      />,
    );
    expect(getByTestId("web-search-progress-card")).toBeTruthy();
  });

  test("header Button owns the hover bg so it scopes to the header region when expanded", () => {
    // JSDOM doesn't compute :hover, so we assert the className contract
    // instead of the computed style. Hover ownership lives on the inner
    // Button (via the ghost variant's `hover:bg-[color-mix(...)]` recipe)
    // rather than on the outer wrapper via `has-[button:hover]:`. When
    // expanded, that confines the hover paint to the header region; when
    // collapsed, the Button fills the whole card so hover still paints
    // everything.
    const { getByRole, getByTestId } = render(
      <WebSearchProgressCard
        currentStepTitle="Searching the web"
        currentStepInfo="my query"
        stepCount="2 steps"
        steps={TWO_THINKING_STEPS}
      />,
    );
    // The outer wrapper no longer reacts to inner hover.
    const card = getByTestId("web-search-progress-card");
    expect(card.className).not.toContain("has-[button:hover]:bg-");
    // The Button paints the color-mix hover recipe itself (inherited from
    // the ghost variant; not stripped by any override).
    const toggle = getByRole("button", { name: /expand steps/i });
    expect(toggle.className).toContain(
      "hover:bg-[color-mix(in_srgb,var(--primary-second-hover)_15%,transparent)]",
    );
  });

  test("Button rounds all four corners when collapsed and only the top when expanded", () => {
    // Padding now lives on the Button, so its hover bg has to paint into
    // the right corners. Rather than putting `overflow-hidden` on the
    // wrapper (which would clip the Button's focus-visible ring), the
    // Button mirrors the wrapper's `rounded-lg` directly — fully rounded
    // when it IS the whole card, top-only when a divider + steps section
    // sits below it.
    const collapsed = render(
      <WebSearchProgressCard
        currentStepTitle="Searching the web"
        currentStepInfo="my query"
        stepCount="2 steps"
        steps={TWO_THINKING_STEPS}
      />,
    );
    const collapsedToggle = collapsed.getByRole("button", {
      name: /expand steps/i,
    });
    expect(collapsedToggle.className).toContain("rounded-[var(--radius-lg)]");
    expect(collapsedToggle.className).not.toContain(
      "rounded-t-[var(--radius-lg)]",
    );
    collapsed.unmount();

    const expanded = render(
      <WebSearchProgressCard
        currentStepTitle="Searching the web"
        currentStepInfo="my query"
        stepCount="2 steps"
        steps={TWO_THINKING_STEPS}
        defaultExpanded
      />,
    );
    const expandedToggle = expanded.getByRole("button", {
      name: /collapse steps/i,
    });
    expect(expandedToggle.className).toContain("rounded-t-[var(--radius-lg)]");
    expect(expandedToggle.className).toContain("rounded-b-none");
  });
});

describe("WebSearchProgressCard — state prop", () => {
  test("renders the three-dot indicator in the loading state", () => {
    const { getByTestId, container } = render(
      <WebSearchProgressCard
        currentStepTitle="Searching the web"
        currentStepInfo="my query"
        stepCount="2 steps"
        steps={TWO_THINKING_STEPS}
        state="loading"
      />,
    );
    const indicator = getByTestId("web-search-status-indicator");
    // The three-dot indicator renders three child <span>s; the check icon
    // is an inline SVG.
    expect(indicator.tagName).toBe("SPAN");
    expect(container.querySelector("svg")).toBeNull();
  });

  test("renders the CheckCircle2 icon in the complete state", () => {
    const { getByTestId, container } = render(
      <WebSearchProgressCard
        currentStepTitle="Searched the web"
        currentStepInfo="my query"
        stepCount="2 steps"
        steps={TWO_THINKING_STEPS}
        state="complete"
      />,
    );
    const indicator = getByTestId("web-search-status-indicator");
    // lucide icons render as <svg> elements.
    expect(indicator.tagName.toLowerCase()).toBe("svg");
    // Sanity check: SVG present.
    expect(container.querySelector("svg")).not.toBeNull();
  });

  test("renders the currentStepInfo subtext in both loading and complete states", () => {
    // The animated step-carousel header always shows the (title, info)
    // tuple — `state` only swaps the indicator icon, not the subtext.
    const loading = render(
      <WebSearchProgressCard
        currentStepTitle="Searching the web"
        currentStepInfo="In-flight subtext"
        stepCount="2 steps"
        steps={TWO_THINKING_STEPS}
        state="loading"
      />,
    );
    expect(loading.getByText("In-flight subtext")).toBeTruthy();
    loading.unmount();

    const complete = render(
      <WebSearchProgressCard
        currentStepTitle="Searched the web"
        currentStepInfo="Completed subtext"
        stepCount="2 steps"
        steps={TWO_THINKING_STEPS}
        state="complete"
      />,
    );
    expect(complete.getByText("Completed subtext")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Header step carousel — throttle + animation contract
// ---------------------------------------------------------------------------
//
// The throttle uses `setTimeout` + `Date.now()` to enforce a 400ms minimum
// dwell between header transitions. bun:test doesn't ship a fake-timers
// helper, so we monkey-patch the globals (same pattern as
// `website-carousel.test.tsx`) and drive timers manually from `act()`.

interface TimerHandle {
  id: number;
  fn: () => void;
  fireAt: number;
  cleared: boolean;
  fired: boolean;
}

describe("WebSearchProgressCard — header step carousel throttling", () => {
  let timers: TimerHandle[] = [];
  let nextTimerId = 1;
  let now = 1_000_000;
  let originalSetTimeout: typeof globalThis.setTimeout;
  let originalClearTimeout: typeof globalThis.clearTimeout;
  let originalDateNow: typeof Date.now;

  beforeEach(() => {
    timers = [];
    nextTimerId = 1;
    now = 1_000_000;
    originalSetTimeout = globalThis.setTimeout;
    originalClearTimeout = globalThis.clearTimeout;
    originalDateNow = Date.now;
    Date.now = () => now;
    globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number) => {
      const handle: TimerHandle = {
        id: nextTimerId++,
        fn: () => fn(),
        fireAt: now + (ms ?? 0),
        cleared: false,
        fired: false,
      };
      timers.push(handle);
      return handle.id as unknown as ReturnType<typeof globalThis.setTimeout>;
    }) as typeof globalThis.setTimeout;
    globalThis.clearTimeout = ((id: number) => {
      const handle = timers.find((h) => h.id === id);
      if (handle) handle.cleared = true;
    }) as typeof globalThis.clearTimeout;
  });

  afterEach(() => {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    Date.now = originalDateNow;
    cleanup();
  });

  /**
   * Advance virtual time by `ms` and fire any timers whose scheduled
   * `fireAt` is now reached. Newly scheduled timers during a callback (the
   * useEffect cleanup race) get picked up in subsequent passes.
   */
  function advanceTime(ms: number) {
    now += ms;
    // Loop so timers scheduled inside a fired callback also fire if they're
    // already due at the advanced `now`. Our throttle never schedules
    // synchronously inside its own callback, but the test stays robust.
    let progressed = true;
    while (progressed) {
      progressed = false;
      const due = timers.filter(
        (h) => !h.cleared && !h.fired && h.fireAt <= now,
      );
      for (const handle of due) {
        handle.fired = true;
        progressed = true;
        act(() => {
          handle.fn();
        });
      }
    }
  }

  test("initial mount shows the supplied title + info immediately (no throttle delay)", () => {
    const { getByText } = render(
      <WebSearchProgressCard
        currentStepTitle="Searching the web"
        currentStepInfo="alpha"
        stepCount="1 step"
        steps={[]}
      />,
    );
    expect(getByText("Searching the web")).toBeTruthy();
    expect(getByText("alpha")).toBeTruthy();
  });

  test("waits for the 400ms minimum dwell before swapping to a new step", () => {
    const { getByText, queryByText, rerender } = render(
      <WebSearchProgressCard
        currentStepTitle="A"
        currentStepInfo="alpha"
        stepCount="1 step"
        steps={[]}
      />,
    );
    expect(getByText("A")).toBeTruthy();
    expect(getByText("alpha")).toBeTruthy();

    rerender(
      <WebSearchProgressCard
        currentStepTitle="B"
        currentStepInfo="beta"
        stepCount="1 step"
        steps={[]}
      />,
    );
    // Throttle holds the old value on-screen until the dwell elapses.
    expect(getByText("A")).toBeTruthy();
    expect(queryByText("B")).toBeNull();

    advanceTime(400);
    expect(getByText("B")).toBeTruthy();
    expect(getByText("beta")).toBeTruthy();
  });

  test("last value always wins when multiple updates arrive inside the dwell window", () => {
    const { getByText, queryByText, rerender } = render(
      <WebSearchProgressCard
        currentStepTitle="A"
        currentStepInfo="alpha"
        stepCount="1 step"
        steps={[]}
      />,
    );

    // Three rapid updates inside 400ms — only the final one should land.
    rerender(
      <WebSearchProgressCard
        currentStepTitle="B"
        currentStepInfo="beta"
        stepCount="1 step"
        steps={[]}
      />,
    );
    advanceTime(50);
    rerender(
      <WebSearchProgressCard
        currentStepTitle="C"
        currentStepInfo="gamma"
        stepCount="1 step"
        steps={[]}
      />,
    );
    advanceTime(50);
    rerender(
      <WebSearchProgressCard
        currentStepTitle="D"
        currentStepInfo="delta"
        stepCount="1 step"
        steps={[]}
      />,
    );

    // Still showing the original — none of the in-window updates have landed.
    expect(getByText("A")).toBeTruthy();
    expect(queryByText("B")).toBeNull();
    expect(queryByText("C")).toBeNull();
    expect(queryByText("D")).toBeNull();

    // After the dwell elapses we should jump straight to D (skipping B and C).
    advanceTime(400);
    expect(getByText("D")).toBeTruthy();
    expect(getByText("delta")).toBeTruthy();
    expect(queryByText("B")).toBeNull();
    expect(queryByText("C")).toBeNull();
  });

  test("re-rendering with the same title + info does not schedule a transition", () => {
    const { rerender } = render(
      <WebSearchProgressCard
        currentStepTitle="A"
        currentStepInfo="alpha"
        stepCount="1 step"
        steps={[]}
      />,
    );
    // Reset the spy count after mount.
    const baselineTimerCount = timers.length;
    rerender(
      <WebSearchProgressCard
        currentStepTitle="A"
        currentStepInfo="alpha"
        stepCount="1 step"
        steps={[]}
      />,
    );
    expect(timers.length).toBe(baselineTimerCount);
  });

  test("omits the pipe separator when currentStepInfo is empty", () => {
    // No info → render just the title (and the bottom step-count pill). The
    // separator chip is keyed off the info string so an empty value never
    // leaves a dangling divider in the header.
    const { container, getByText } = render(
      <WebSearchProgressCard
        currentStepTitle="Searched the web"
        currentStepInfo=""
        stepCount="1 step"
        steps={[]}
      />,
    );
    expect(getByText("Searched the web")).toBeTruthy();
    // The pipe separator is the only `aria-hidden="true"` <span> inside the
    // animated header containing the literal "|" — none should be present.
    const hiddenSpans = Array.from(
      container.querySelectorAll('span[aria-hidden="true"]'),
    );
    expect(hiddenSpans.every((s) => s.textContent !== "|")).toBe(true);
  });
});

// Reduced-motion coverage for the header step carousel lives in a sibling
// file (`web-search-progress-card.reduced-motion.test.tsx`) because the
// `mock.module("motion/react", ...)` stub it relies on bleeds across files
// in the same test run, breaking unrelated `motion/react`-using suites that
// run afterwards. Splitting it out matches the isolation pattern used by
// the existing reduced-motion check in `website-carousel.test.tsx`.
