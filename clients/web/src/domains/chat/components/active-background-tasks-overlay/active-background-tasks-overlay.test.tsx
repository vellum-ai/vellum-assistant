/**
 * Tests for `ActiveBackgroundTasksOverlay`.
 *
 * `BackgroundTaskInlineProgressCard` renders `null` until its store entry
 * exists (spawn race), so it is mocked to a testid stub here to keep the
 * overlay test focused on the overlay's own empty/collapsed/expanded states,
 * the per-row open callback, and Escape / outside-click dismissal — not
 * background-task-store hydration.
 */

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement, type ReactElement, type ReactNode } from "react";

// Mock `motion/react` so the dropdown mounts/unmounts synchronously. The real
// AnimatePresence exit runs ~1.8s in happy-dom; under full-suite load that
// overran the per-test timeout and flaked the drill-in/dismissal assertions
// (which wait for the panel to leave the DOM). This strips motion-only props
// and forwards className/style/children so the layout assertions still hold.
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
    // Render children immediately and drop them synchronously on unmount (no
    // exit hold) so close-on-drill-in / Escape / outside-click assertions don't
    // depend on real animation timing.
    AnimatePresence: ({ children }: { children?: ReactNode }) => children,
    useReducedMotion: () => true,
  };
});

mock.module(
  "@/domains/chat/components/background-task-inline-card/background-task-inline-progress-card",
  () => ({
    // Mirrors the real card's affordance (open present only when clickable) so
    // the overlay's drill-in wiring can be exercised without hydrating the
    // background-task store.
    BackgroundTaskInlineProgressCard: ({
      id,
      onClick,
    }: {
      id: string;
      onClick?: (id: string) => void;
    }) => (
      <div data-testid="bg-task-card" data-id={id}>
        {onClick ? (
          <button
            type="button"
            aria-label="Open command"
            onClick={() => onClick(id)}
          />
        ) : null}
      </div>
    ),
  }),
);

import { ActiveBackgroundTasksOverlay } from "@/domains/chat/components/active-background-tasks-overlay/active-background-tasks-overlay";

afterEach(() => {
  cleanup();
});

afterAll(() => {
  mock.restore();
});

function makeIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `bg-${i}`);
}

describe("ActiveBackgroundTasksOverlay — empty", () => {
  test("renders nothing when taskIds is empty", () => {
    const { queryByTestId } = render(
      <ActiveBackgroundTasksOverlay taskIds={[]} />,
    );
    expect(queryByTestId("active-background-tasks-overlay")).toBeNull();
  });
});

describe("ActiveBackgroundTasksOverlay — collapsed", () => {
  test("shows the pill and hides the panel", () => {
    const ids = makeIds(3);
    const { queryByText, queryAllByTestId } = render(
      <ActiveBackgroundTasksOverlay taskIds={ids} />,
    );

    const pill = screen.getByRole("button", { name: /active commands/i });
    expect(pill).toBeTruthy();
    expect(pill.getAttribute("aria-expanded")).toBe("false");
    // Panel is collapsed: no title, no cards.
    expect(queryByText("3 Active Commands")).toBeNull();
    expect(queryAllByTestId("bg-task-card").length).toBe(0);
  });

  test("root is pointer-events-none so the gutter doesn't block the transcript", () => {
    const ids = makeIds(2);
    render(<ActiveBackgroundTasksOverlay taskIds={ids} />);
    expect(
      screen.getByTestId("active-background-tasks-overlay").className,
    ).toContain("pointer-events-none");
  });

  test("collapses overflow above the glyph cap into a +N label", () => {
    render(<ActiveBackgroundTasksOverlay taskIds={makeIds(8)} />);
    // 6 glyphs visible, remainder (2) shown as "+2".
    expect(screen.getByText("+2")).toBeTruthy();
  });
});

describe("ActiveBackgroundTasksOverlay — expanded", () => {
  test("clicking the pill reveals the panel with the title and one card per id", () => {
    const ids = makeIds(3);
    const { getByText, getAllByTestId } = render(
      <ActiveBackgroundTasksOverlay taskIds={ids} />,
    );

    const pill = screen.getByRole("button", { name: /active commands/i });
    fireEvent.click(pill);

    expect(pill.getAttribute("aria-expanded")).toBe("true");
    expect(getByText("3 Active Commands")).toBeTruthy();
    expect(getAllByTestId("bg-task-card").length).toBe(3);
  });

  test("uses the singular noun when exactly one task is active", () => {
    render(<ActiveBackgroundTasksOverlay taskIds={makeIds(1)} />);

    fireEvent.click(screen.getByRole("button", { name: /active command/i }));

    expect(screen.getByText("1 Active Command")).toBeTruthy();
    expect(screen.queryByText("1 Active Commands")).toBeNull();
  });
});

describe("ActiveBackgroundTasksOverlay — drill-in", () => {
  test("opening a row fires onTaskClick and closes the dropdown", async () => {
    const ids = makeIds(2);
    const opened: string[] = [];
    const { queryByText } = render(
      <ActiveBackgroundTasksOverlay
        taskIds={ids}
        onTaskClick={(id) => opened.push(id)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /active commands/i }));
    expect(queryByText("2 Active Commands")).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: /open command/i })[0]);

    expect(opened).toEqual(["bg-0"]);
    await waitFor(() => expect(queryByText("2 Active Commands")).toBeNull(), {
      timeout: 4000,
    });
  });
});

describe("ActiveBackgroundTasksOverlay — dismissal", () => {
  test("Escape collapses the open panel", async () => {
    const ids = makeIds(2);
    const { queryByText } = render(
      <ActiveBackgroundTasksOverlay taskIds={ids} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /active commands/i }));
    expect(queryByText("2 Active Commands")).toBeTruthy();

    // Escape collapses the dropdown AND claims the event (preventDefault) so a
    // single Escape doesn't also close an underlying side panel. fireEvent
    // returns false when the event was canceled.
    const notCanceled = fireEvent.keyDown(document, { key: "Escape" });
    expect(notCanceled).toBe(false);
    await waitFor(() => expect(queryByText("2 Active Commands")).toBeNull(), {
      timeout: 4000,
    });
  });

  test("pointerdown outside the container collapses the open panel", async () => {
    const ids = makeIds(2);
    const { queryByText } = render(
      <ActiveBackgroundTasksOverlay taskIds={ids} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /active commands/i }));
    expect(queryByText("2 Active Commands")).toBeTruthy();

    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(queryByText("2 Active Commands")).toBeNull(), {
      timeout: 4000,
    });
  });
});
