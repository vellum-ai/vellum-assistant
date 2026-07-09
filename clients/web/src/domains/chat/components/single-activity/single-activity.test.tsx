/**
 * Tests for the inline `SingleActivity` link — the lone affordance for one step
 * of agent work, in its two variants:
 *
 *   - `variant="thinking"` — an assistant reasoning run. Covers the glyph-less
 *     two-state "Thinking" label (static settled / shimmering streamed) with
 *     its trailing chevron, the drawer-open/toggle click contract, and the
 *     empty-content render rules.
 *   - `variant="tool"` — a lone renderable tool call. Covers the bare derived
 *     label (no leading glyph, no inline risk badge — risk lives in the detail
 *     drawer), the toggle-drawer click contract (via the shared
 *     `toolDetailPayloadFromToolCall` payload), and the active state when the
 *     store's `activeToolDetail` matches this call.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render } from "@testing-library/react";

import type { WebSearchResultItem } from "@/assistant/web-activity-types";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { ToolCallCardStep } from "@/domains/chat/utils/tool-call-card-utils";

// The viewer store imports the generated daemon SDK, which isn't built in
// CI/worktree checkouts. Stub the two endpoints it references so the module
// loads. Component + store are imported dynamically below so the mock is
// registered first.
mock.module("@/generated/daemon/sdk.gen", () => ({
  appsByIdOpenPost: async () => ({ data: undefined }),
  documentsByIdGet: async () => ({ data: undefined }),
}));

const { SingleActivity } = await import(
  "@/domains/chat/components/single-activity/single-activity"
);
const { useViewerStore } = await import("@/stores/viewer-store");
const { toolDetailPayloadFromToolCall } = await import(
  "@/domains/chat/utils/tool-call-card-utils"
);

const CONTENT = "Let me reason about the next step before acting.";
const startedAt = 1_717_000_000_000;

function makeToolCall(
  overrides: Partial<ChatMessageToolCall> = {},
): ChatMessageToolCall {
  return {
    id: "tc-1",
    name: "bash",
    input: { command: "date", activity: "Checking the current time" },
    riskLevel: "low",
    startedAt,
    completedAt: startedAt + 2_000,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  // The click writes to the real viewer store — reset the drawer state between
  // tests so assertions don't bleed across cases.
  useViewerStore.setState({ activeToolDetail: null, mainView: "chat" });
});

describe("SingleActivity — thinking variant", () => {
  test("renders the label and trailing chevron, with no leading glyph", () => {
    const { getByTestId, getByText, container } = render(
      <SingleActivity variant="thinking" content={CONTENT} />,
    );

    expect(getByTestId("thought-process-link")).toBeTruthy();
    expect(getByText("Thinking")).toBeTruthy();
    // ChevronRight (trailing) is the only lucide glyph — no leading icon.
    expect(container.querySelectorAll("svg").length).toBe(1);
  });

  test("clicking opens the thinking detail drawer with the full reasoning", () => {
    const { getByLabelText } = render(
      <SingleActivity variant="thinking" content={CONTENT} />,
    );

    fireEvent.click(getByLabelText("View thinking"));

    const detail = useViewerStore.getState().activeToolDetail;
    expect(detail?.kind).toBe("thinking");
    expect(detail?.title).toBe("Thought process");
    expect(detail?.thinkingText).toBe(CONTENT);
    expect(useViewerStore.getState().mainView).toBe("tool-detail");
  });

  test("clicking again toggles the drawer closed", () => {
    const { getByLabelText } = render(
      <SingleActivity variant="thinking" content={CONTENT} />,
    );

    // Open, then click the now-active link to close it.
    fireEvent.click(getByLabelText("View thinking"));
    expect(useViewerStore.getState().mainView).toBe("tool-detail");

    fireEvent.click(getByLabelText("View thinking"));
    expect(useViewerStore.getState().activeToolDetail).toBeNull();
    expect(useViewerStore.getState().mainView).toBe("chat");
  });

  test("while streaming, shimmers the same 'Thinking' label", () => {
    const { getByTestId, getByText, queryByText, container } = render(
      <SingleActivity variant="thinking" content={CONTENT} isStreaming />,
    );

    // The label stays "Thinking" — never the reasoning text itself.
    expect(getByText("Thinking")).toBeTruthy();
    expect(queryByText(CONTENT)).toBeNull();
    // The label renders through the streaming shimmer; the trailing chevron
    // is the only svg (no leading glyph).
    expect(getByTestId("thought-process-loading")).toBeTruthy();
    expect(container.querySelectorAll("svg").length).toBe(1);
  });

  test("stays clickable while streaming — opens the live reasoning in the drawer", () => {
    const { getByLabelText } = render(
      <SingleActivity variant="thinking" content={CONTENT} isStreaming />,
    );

    fireEvent.click(getByLabelText("View thinking"));

    const detail = useViewerStore.getState().activeToolDetail;
    expect(detail?.kind).toBe("thinking");
    expect(detail?.thinkingText).toBe(CONTENT);
    expect(useViewerStore.getState().mainView).toBe("tool-detail");
  });

  test("renders while streaming even before any reasoning text arrives", () => {
    const { getByTestId, getByText } = render(
      <SingleActivity variant="thinking" content="" isStreaming />,
    );
    expect(getByTestId("thought-process-link")).toBeTruthy();
    expect(getByTestId("thought-process-loading")).toBeTruthy();
    expect(getByText("Thinking")).toBeTruthy();
  });

  test("renders nothing when content is empty and not streaming", () => {
    const { queryByTestId } = render(
      <SingleActivity variant="thinking" content="" />,
    );
    expect(queryByTestId("thought-process-link")).toBeNull();
  });

  test("renders active when its reasoning is the one open in the drawer", () => {
    useViewerStore.setState({
      mainView: "tool-detail",
      activeToolDetail: {
        kind: "thinking",
        toolCallId: "",
        toolName: "",
        title: "Thought process",
        activity: "",
        input: {},
        status: "completed",
        thinkingText: CONTENT,
      },
    });

    const { getByTestId } = render(
      <SingleActivity variant="thinking" content={CONTENT} />,
    );
    expect(
      getByTestId("thought-process-link").getAttribute("data-active"),
    ).toBe("true");
  });

  test("carries the (message, group) identity into the drawer payload", () => {
    const { getByLabelText } = render(
      <SingleActivity
        variant="thinking"
        content={CONTENT}
        messageId="m1"
        groupIndex={2}
      />,
    );

    fireEvent.click(getByLabelText("View thinking"));

    const detail = useViewerStore.getState().activeToolDetail;
    expect(detail?.messageId).toBe("m1");
    expect(detail?.thinkingGroupIndex).toBe(2);
    // The bare panel shows the whole group's reasoning, so it carries no segment
    // index — that drives `useLiveThinkingText` to return the combined text.
    expect(detail?.thinkingItemIndex).toBeUndefined();
  });

  test("stays active by identity while the reasoning streams past the snapshot", () => {
    // The drawer was opened earlier in the turn (shorter snapshot); the live
    // link has since grown. Identity keying keeps the highlight on rather than
    // dropping it the moment the text diverges from the snapshot.
    useViewerStore.setState({
      mainView: "tool-detail",
      activeToolDetail: {
        kind: "thinking",
        toolCallId: "",
        toolName: "",
        title: "Thought process",
        activity: "",
        input: {},
        status: "completed",
        thinkingText: "earlier shorter snapshot",
        messageId: "m1",
        thinkingGroupIndex: 0,
      },
    });

    const { getByTestId } = render(
      <SingleActivity
        variant="thinking"
        content={`${CONTENT} ...and more reasoning`}
        messageId="m1"
        groupIndex={0}
      />,
    );
    expect(
      getByTestId("thought-process-link").getAttribute("data-active"),
    ).toBe("true");
  });
});

describe("SingleActivity — tool variant", () => {
  test("renders the derived label and chevron — no leading glyph, no risk badge", () => {
    const { getByTestId, getByText, queryByTestId, container } = render(
      <SingleActivity variant="tool" toolCall={makeToolCall()} />,
    );

    expect(getByTestId("inline-tool-link")).toBeTruthy();
    // `activity` wins as the label.
    expect(getByText("Checking the current time")).toBeTruthy();
    // The risk assessment lives in the detail drawer, not on the inline link.
    expect(queryByTestId("risk-badge")).toBeNull();
    // ChevronRight (trailing) is the only svg.
    expect(container.querySelectorAll("svg").length).toBe(1);
  });

  test("clicking toggles the tool-detail drawer with the shared payload", () => {
    const toolCall = makeToolCall();
    const { getByTestId } = render(
      <SingleActivity variant="tool" toolCall={toolCall} />,
    );

    fireEvent.click(getByTestId("inline-tool-link"));

    const detail = useViewerStore.getState().activeToolDetail;
    expect(detail).toEqual(toolDetailPayloadFromToolCall(toolCall));
    expect(useViewerStore.getState().mainView).toBe("tool-detail");

    // Clicking the already-open chip closes the drawer (toggle).
    fireEvent.click(getByTestId("inline-tool-link"));
    expect(useViewerStore.getState().activeToolDetail).toBeNull();
    expect(useViewerStore.getState().mainView).toBe("chat");
  });

  test("renders active when the store's activeToolDetail matches this call", () => {
    const toolCall = makeToolCall({ id: "tc-active" });
    useViewerStore.setState({
      mainView: "tool-detail",
      activeToolDetail: toolDetailPayloadFromToolCall(toolCall),
    });

    const { getByTestId } = render(
      <SingleActivity variant="tool" toolCall={toolCall} />,
    );
    expect(getByTestId("inline-tool-link").getAttribute("data-active")).toBe(
      "true",
    );
    expect(getByTestId("inline-tool-link").className).toContain(
      "bg-[var(--surface-active)]",
    );
  });

  test("renders the error tone for a failed call", () => {
    const { getByTestId } = render(
      <SingleActivity
        variant="tool"
        toolCall={makeToolCall({ id: "tc-error", isError: true })}
      />,
    );
    expect(getByTestId("inline-tool-link").className).toContain(
      "text-[var(--system-negative-strong)]",
    );
  });
});

describe("SingleActivity — web variant", () => {
  function makeResult(
    overrides: Partial<WebSearchResultItem> = {},
  ): WebSearchResultItem {
    return {
      rank: 1,
      title: "Toronto - Wikipedia",
      url: "https://en.wikipedia.org/wiki/Toronto",
      domain: "en.wikipedia.org",
      ...overrides,
    };
  }

  const RESULTS: WebSearchResultItem[] = [
    makeResult(),
    makeResult({
      rank: 2,
      title: "Visit Toronto",
      url: "https://www.destinationtoronto.com",
      domain: "destinationtoronto.com",
    }),
  ];

  const WEB_STEP: Extract<ToolCallCardStep, { kind: "web_search" }> = {
    kind: "web_search",
    title: "Searched the web",
    durationLabel: "1s",
    linkCount: 2,
    results: RESULTS,
  };

  const ERROR_STEP: Extract<
    ToolCallCardStep,
    { kind: "web_search_error" }
  > = {
    kind: "web_search_error",
    title: "Web search failed",
    durationLabel: "1s",
    errorMessage: "Search provider unavailable",
  };

  test("renders the 'Web Search' label in the header", () => {
    const { getByTestId, getByText } = render(
      <SingleActivity
        variant="web"
        info="en.wikipedia.org"
        carouselItems={RESULTS}
        state="complete"
        step={WEB_STEP}
        expanded={false}
        onExpandChange={() => {}}
      />,
    );
    expect(getByTestId("inline-web-link")).toBeTruthy();
    expect(getByText("Web Search")).toBeTruthy();
    // The flex-col wrapper uses items-start so the header button hugs its
    // content width rather than stretching to fill the row.
    expect(getByTestId("inline-web-link").parentElement?.className).toContain(
      "items-start",
    );
  });

  test("rotates the WebsiteCarousel in the info slot while loading", () => {
    const { container } = render(
      <SingleActivity
        variant="web"
        info="en.wikipedia.org"
        carouselItems={RESULTS}
        state="loading"
        step={WEB_STEP}
        expanded={false}
        onExpandChange={() => {}}
      />,
    );
    // The carousel renders favicon chips for the rotating sites; its fixed-height
    // ticker wrapper is its tell. Only shown while the search is in flight.
    expect(container.querySelector(".h-\\[28px\\]")).toBeTruthy();
  });

  test("shows the latest page title (not the carousel) once settled", () => {
    const { getByText, container } = render(
      <SingleActivity
        variant="web"
        info="Visit Toronto — Official Tourism"
        carouselItems={RESULTS}
        state="complete"
        step={WEB_STEP}
        expanded={false}
        onExpandChange={() => {}}
      />,
    );
    // Settled state shows the latest page title as static text, never the
    // (zero-width-inline) carousel — even when carouselItems are present.
    expect(getByText("Visit Toronto — Official Tourism")).toBeTruthy();
    expect(container.querySelector(".h-\\[28px\\]")).toBeNull();
  });

  test("renders the latest page's favicon (or monogram) beside the settled title", () => {
    const { getByTestId, getByText } = render(
      <SingleActivity
        variant="web"
        info="Visit Toronto — Official Tourism"
        carouselItems={RESULTS}
        state="complete"
        step={WEB_STEP}
        expanded={false}
        onExpandChange={() => {}}
      />,
    );
    // The favicon for the LAST result (carouselItems.at(-1)) sits beside the
    // title. RESULTS' last item has no faviconUrl, so the monogram of its
    // domain ("destinationtoronto.com" → "D") renders inside the slot.
    const slot = getByTestId("site-favicon");
    expect(slot).toBeTruthy();
    expect(slot.textContent).toBe("D");
    expect(getByText("Visit Toronto — Official Tourism")).toBeTruthy();
  });

  test("renders the favicon <img> when the latest result has a faviconUrl", () => {
    const withFavicon: WebSearchResultItem[] = [
      makeResult({
        rank: 1,
        title: "Toronto Travel",
        domain: "destinationtoronto.com",
        faviconUrl: "https://destinationtoronto.com/favicon.ico",
      }),
    ];
    const { container } = render(
      <SingleActivity
        variant="web"
        info="Toronto Travel"
        carouselItems={withFavicon}
        state="complete"
        step={WEB_STEP}
        expanded={false}
        onExpandChange={() => {}}
      />,
    );
    const img = container.querySelector('[data-testid="site-favicon"] img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe(
      "https://destinationtoronto.com/favicon.ico",
    );
  });

  test("shows the static info text (no favicon) when carouselItems is empty", () => {
    const { getByText, queryByTestId, container } = render(
      <SingleActivity
        variant="web"
        info="en.wikipedia.org"
        carouselItems={[]}
        state="complete"
        step={WEB_STEP}
        expanded={false}
        onExpandChange={() => {}}
      />,
    );
    expect(getByText("en.wikipedia.org")).toBeTruthy();
    // No latest result → no favicon rendered next to the title.
    expect(queryByTestId("site-favicon")).toBeNull();
    // No carousel ticker wrapper when there are no items.
    expect(container.querySelector(".h-\\[28px\\]")).toBeNull();
  });

  test("collapsed hides the favicon result row", () => {
    const { queryByTestId } = render(
      <SingleActivity
        variant="web"
        info="en.wikipedia.org"
        carouselItems={[]}
        state="complete"
        step={WEB_STEP}
        expanded={false}
        onExpandChange={() => {}}
      />,
    );
    // FaviconChip rows carry a title attribute; none should render collapsed.
    expect(queryByTestId("web-search-overflow-chip")).toBeNull();
  });

  test("clicking the header calls onExpandChange(true) when collapsed", () => {
    let next: boolean | undefined;
    const { getByTestId } = render(
      <SingleActivity
        variant="web"
        info="en.wikipedia.org"
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

  test("clicking the header calls onExpandChange(false) when expanded", () => {
    let next: boolean | undefined;
    const { getByTestId } = render(
      <SingleActivity
        variant="web"
        info="en.wikipedia.org"
        carouselItems={[]}
        state="complete"
        step={WEB_STEP}
        expanded
        onExpandChange={(v) => {
          next = v;
        }}
      />,
    );
    fireEvent.click(getByTestId("inline-web-link"));
    expect(next).toBe(false);
  });

  test("expanded reveals the favicon result row (WebSearchStepRow)", () => {
    const { getByText } = render(
      <SingleActivity
        variant="web"
        info="en.wikipedia.org"
        carouselItems={[]}
        state="complete"
        step={WEB_STEP}
        expanded
        onExpandChange={() => {}}
      />,
    );
    // FaviconChip renders each result's title as the chip label. carouselItems
    // is empty here, so these can only come from the expanded step row.
    expect(getByText("Toronto - Wikipedia")).toBeTruthy();
    expect(getByText("Visit Toronto")).toBeTruthy();
  });

  test("expanded result pills are ToolStepPill web links to the source URL", () => {
    const { getAllByTestId } = render(
      <SingleActivity
        variant="web"
        info="en.wikipedia.org"
        carouselItems={[]}
        state="complete"
        step={WEB_STEP}
        expanded
        onExpandChange={() => {}}
      />,
    );
    // Web results render as the shared ToolStepPill (web variant) — an anchor
    // pill opening the source in a new tab.
    const pills = getAllByTestId("tool-step-pill");
    expect(pills.length).toBe(2);
    expect(pills[0]!.tagName.toLowerCase()).toBe("a");
    expect(pills[0]!.getAttribute("data-variant")).toBe("web");
    expect(pills[0]!.getAttribute("href")).toBe(
      "https://en.wikipedia.org/wiki/Toronto",
    );
    expect(pills[0]!.getAttribute("target")).toBe("_blank");
    expect(pills[0]!.getAttribute("rel")).toContain("noopener");
  });

  test("loading state renders the three-dot indicator", () => {
    const { getByTestId } = render(
      <SingleActivity
        variant="web"
        info="en.wikipedia.org"
        carouselItems={[]}
        state="loading"
        step={WEB_STEP}
        expanded={false}
        onExpandChange={() => {}}
      />,
    );
    expect(getByTestId("inline-web-loading")).toBeTruthy();
  });

  test("a web_search_error step renders the error chip when expanded", () => {
    const { getByTestId, getByText } = render(
      <SingleActivity
        variant="web"
        info="en.wikipedia.org"
        carouselItems={[]}
        state="error"
        step={ERROR_STEP}
        expanded
        onExpandChange={() => {}}
      />,
    );
    expect(getByTestId("web-search-error-chip")).toBeTruthy();
    expect(getByText("Search provider unavailable")).toBeTruthy();
  });

  test("error state applies the negative tone to the header", () => {
    const { getByTestId } = render(
      <SingleActivity
        variant="web"
        info="en.wikipedia.org"
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
    expect(getByTestId("inline-web-link")).toBeTruthy();
    expect(queryByText("Toronto - Wikipedia")).toBeNull();
  });
});
