/**
 * Tests for `ActiveProcessOverlay` — the generic, registry-driven "active X"
 * chat overlay. Driven by a FAKE `BackgroundProcessDescriptor` (stub hooks +
 * handlers, no store) so we can assert behavior parity with the bespoke
 * overlays it replaces:
 *
 *  - Empty `ids` → renders nothing (self-gating).
 *  - Non-empty → the pill shows with the descriptor's aria label; the dropdown
 *    is collapsed until the pill is toggled.
 *  - Expanding renders one `InlineProcessCard` row per id.
 *  - Opening a row calls `onOpenDetail(id)` and closes the dropdown.
 *  - The stop button calls `onStop(id)`.
 *  - Both `pill.variant` branches ("stacked" + "count") render their pill chrome.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement, type ReactElement, type ReactNode } from "react";

import { ActiveProcessOverlay } from "@/domains/chat/process-registry/active-process-overlay";
import type {
  BackgroundProcessDescriptor,
  CardSummary,
  ProcessPillConfig,
} from "@/domains/chat/process-registry/types";

// Mock `motion/react` so the dropdown mounts/unmounts synchronously. The real
// AnimatePresence exit holds the panel in the DOM for ~1.8s in happy-dom, which
// would flake the close-on-drill-in assertion. This strips motion-only props
// and forwards className/style/children so layout/aria assertions still hold.
// Mirrors the bespoke `active-workflows-overlay.test.tsx` mock.
mock.module("motion/react", () => {
  const MOTION_ONLY_PROPS = new Set([
    "initial",
    "animate",
    "exit",
    "transition",
    "variants",
    "whileHover",
    "whileTap",
    "whileFocus",
    "whileInView",
    "whileDrag",
    "layout",
    "layoutId",
    "drag",
    "custom",
    "onAnimationStart",
    "onAnimationComplete",
  ]);
  return {
    motion: new Proxy(
      {} as Record<string, (props: Record<string, unknown>) => ReactElement>,
      {
        get: (_target, tag) => (props: Record<string, unknown>) => {
          const domProps: Record<string, unknown> = {};
          for (const key in props) {
            if (!MOTION_ONLY_PROPS.has(key)) domProps[key] = props[key];
          }
          return createElement(String(tag), domProps);
        },
      },
    ),
    AnimatePresence: ({ children }: { children?: ReactNode }) => children,
    useReducedMotion: () => true,
  };
});

afterEach(() => {
  cleanup();
});

const STACKED_PILL: ProcessPillConfig = {
  variant: "stacked",
  renderChip: (id) => <span key={id} data-testid="stub-chip" data-id={id} />,
  max: 6,
};

const COUNT_PILL: ProcessPillConfig = {
  variant: "count",
  glyph: <span data-testid="stub-glyph" />,
};

function summaryFor(id: string): CardSummary {
  return {
    state: "loading",
    title: `Process ${id}`,
    info: "running",
  };
}

/**
 * Builds a fake descriptor. `useCardSummary` is a real hook-shaped function (it
 * just returns a fixed summary), satisfying the hooks-in-a-component rule that
 * `OverlayRow` relies on. `useActiveIds` is unused by this component (ids are
 * passed in) but required by the type.
 */
function fakeDescriptor(
  pill: ProcessPillConfig,
  overrides: Partial<BackgroundProcessDescriptor> = {},
): BackgroundProcessDescriptor {
  return {
    kind: "subagent",
    useActiveIds: () => [],
    useCardSummary: (id) => summaryFor(id),
    renderCardLeading: (id) => <span data-testid="stub-leading" data-id={id} />,
    pill,
    overlayTitle: (count) => `${count} Active`,
    pillAriaLabel: (count) => `${count} active processes`,
    openCardAriaLabel: "Open process",
    onOpenDetail: () => {},
    DetailPanel: () => null,
    ...overrides,
  };
}

describe("ActiveProcessOverlay — gating", () => {
  test("renders nothing when ids is empty", () => {
    const { container } = render(
      <ActiveProcessOverlay descriptor={fakeDescriptor(STACKED_PILL)} ids={[]} />,
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("active-subagent-overlay")).toBeNull();
  });
});

describe("ActiveProcessOverlay — pill variants", () => {
  test("stacked variant renders the stacked-chips pill", () => {
    render(
      <ActiveProcessOverlay
        descriptor={fakeDescriptor(STACKED_PILL)}
        ids={["a", "b"]}
      />,
    );

    const pill = screen.getByRole("button", { name: "2 active processes" });
    expect(pill.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getAllByTestId("stub-chip").length).toBe(2);
  });

  test("count variant renders the count pill (glyph + count + chevron)", () => {
    const { container } = render(
      <ActiveProcessOverlay
        descriptor={fakeDescriptor(COUNT_PILL)}
        ids={["a", "b", "c"]}
      />,
    );

    const pill = screen.getByRole("button", { name: "3 active processes" });
    expect(pill.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("stub-glyph")).toBeTruthy();
    // The numeric count is rendered next to the glyph.
    expect(screen.getByText("3")).toBeTruthy();
    expect(container.querySelector(".lucide-chevron-down")).toBeTruthy();
  });
});

describe("ActiveProcessOverlay — expand & rows", () => {
  test("expanding shows one row per id with the descriptor title", () => {
    render(
      <ActiveProcessOverlay
        descriptor={fakeDescriptor(STACKED_PILL)}
        ids={["a", "b", "c"]}
      />,
    );

    // Collapsed: no rows yet.
    expect(screen.queryByText("Process a")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "3 active processes" }));

    expect(screen.getByText("3 Active")).toBeTruthy();
    expect(screen.getByText("Process a")).toBeTruthy();
    expect(screen.getByText("Process b")).toBeTruthy();
    expect(screen.getByText("Process c")).toBeTruthy();
  });

  test("a row whose summary is null does not render", () => {
    const descriptor = fakeDescriptor(STACKED_PILL, {
      useCardSummary: (id) => (id === "b" ? null : summaryFor(id)),
    });
    render(<ActiveProcessOverlay descriptor={descriptor} ids={["a", "b"]} />);

    fireEvent.click(screen.getByRole("button", { name: "2 active processes" }));

    expect(screen.getByText("Process a")).toBeTruthy();
    expect(screen.queryByText("Process b")).toBeNull();
  });
});

describe("ActiveProcessOverlay — row interactions", () => {
  test("opening a row calls onOpenDetail(id) and closes the dropdown", async () => {
    const onOpenDetail = mock((_id: string) => {});
    const descriptor = fakeDescriptor(STACKED_PILL, { onOpenDetail });
    render(<ActiveProcessOverlay descriptor={descriptor} ids={["a", "b"]} />);

    fireEvent.click(screen.getByRole("button", { name: "2 active processes" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Open process" })[0]!);

    expect(onOpenDetail).toHaveBeenCalledTimes(1);
    expect(onOpenDetail.mock.calls[0]![0]).toBe("a");
    // Dropdown dismissed → rows gone (overlay title leaves the DOM).
    await waitFor(() => expect(screen.queryByText("2 Active")).toBeNull());
  });

  test("the stop button calls onStop(id)", () => {
    const onStop = mock((_id: string) => {});
    const descriptor = fakeDescriptor(STACKED_PILL, { onStop });
    render(<ActiveProcessOverlay descriptor={descriptor} ids={["a", "b"]} />);

    fireEvent.click(screen.getByRole("button", { name: "2 active processes" }));
    fireEvent.click(screen.getAllByTestId("inline-process-card-stop")[0]!);

    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onStop.mock.calls[0]![0]).toBe("a");
  });

  test("no stop button when the descriptor omits onStop", () => {
    render(
      <ActiveProcessOverlay
        descriptor={fakeDescriptor(STACKED_PILL)}
        ids={["a"]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "1 active processes" }));
    expect(screen.queryByTestId("inline-process-card-stop")).toBeNull();
  });
});
