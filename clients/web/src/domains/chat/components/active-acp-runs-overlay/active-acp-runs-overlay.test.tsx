/**
 * Tests for `ActiveAcpRunsOverlay`.
 *
 * Seeds the Zustand ACP run store with `running` entries for each id (the
 * reused `AcpRunInlineProgressCard` reads the store and renders `null` until
 * the entry lands), then asserts the empty/collapsed/expanded states, the
 * per-row open callback (`openAcpRunDetail`), and Escape / outside-click
 * dismissal.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement, type ReactElement, type ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

// Mock `motion/react` so the shell's dropdown mounts/unmounts synchronously.
// The real AnimatePresence exit lingers in happy-dom; under full-suite load
// that flaked the dismissal assertions (which wait for the panel to leave the
// DOM). Strip motion-only props and forward className/style/children so layout
// assertions still hold.
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

import { ActiveAcpRunsOverlay } from "@/domains/chat/components/active-acp-runs-overlay/active-acp-runs-overlay";
import { useAcpRunStore } from "@/domains/chat/acp-run-store";

const NOW = 1700000000000;

beforeEach(() => {
  useAcpRunStore.getState().reset();
});

afterEach(() => {
  cleanup();
});

function seed(id: string) {
  useAcpRunStore.getState().spawnRun({
    acpSessionId: id,
    agent: "claude",
    parentConversationId: "conv-1",
    startedAt: NOW,
  });
}

function seedMany(count: number): string[] {
  const ids = Array.from({ length: count }, (_, i) => `acp-${i}`);
  act(() => ids.forEach(seed));
  return ids;
}

function seedAgent(id: string, agent: string) {
  useAcpRunStore.getState().spawnRun({
    acpSessionId: id,
    agent,
    parentConversationId: "conv-1",
    startedAt: NOW,
  });
}

describe("ActiveAcpRunsOverlay — empty", () => {
  test("renders nothing when acpRunIds is empty", () => {
    const { queryByTestId } = render(<ActiveAcpRunsOverlay acpRunIds={[]} />);
    expect(queryByTestId("active-acp-runs-overlay")).toBeNull();
  });
});

describe("ActiveAcpRunsOverlay — collapsed", () => {
  test("shows the pill and hides the panel", () => {
    const ids = seedMany(3);
    const { queryByText } = render(<ActiveAcpRunsOverlay acpRunIds={ids} />);

    const pill = screen.getByRole("button", { name: /active runs/i });
    expect(pill).toBeTruthy();
    expect(pill.getAttribute("aria-expanded")).toBe("false");
    expect(queryByText("3 Active Runs")).toBeNull();
  });

  test("root is pointer-events-none so the gutter doesn't block the transcript", () => {
    const ids = seedMany(2);
    render(<ActiveAcpRunsOverlay acpRunIds={ids} />);
    expect(screen.getByTestId("active-acp-runs-overlay").className).toContain(
      "pointer-events-none",
    );
  });
});

describe("ActiveAcpRunsOverlay — pill agent marks", () => {
  test("shows one agent brand mark per run while collapsed", () => {
    const ids = seedMany(3);
    const { getAllByTestId } = render(<ActiveAcpRunsOverlay acpRunIds={ids} />);
    expect(getAllByTestId("acp-agent-icon-brand").length).toBe(3);
  });

  test("caps visible marks at six and shows a +N overflow", () => {
    const ids = seedMany(8);
    const { getAllByTestId, getByText } = render(
      <ActiveAcpRunsOverlay acpRunIds={ids} />,
    );
    expect(getAllByTestId("acp-agent-icon-brand").length).toBe(6);
    expect(getByText("+2")).toBeTruthy();
  });

  test("renders the correct brand mark per agent (claude vs codex)", () => {
    act(() => {
      seedAgent("acp-claude", "claude");
      seedAgent("acp-codex", "gpt-5-codex");
    });
    const { getAllByTestId } = render(
      <ActiveAcpRunsOverlay acpRunIds={["acp-claude", "acp-codex"]} />,
    );
    const srcs = getAllByTestId("acp-agent-icon-brand").map((el) =>
      el.getAttribute("src"),
    );
    expect(srcs.some((s) => s?.includes("claude.svg"))).toBe(true);
    expect(srcs.some((s) => s?.includes("chatgpt.svg"))).toBe(true);
  });
});

describe("ActiveAcpRunsOverlay — expanded", () => {
  test("clicking the pill reveals the panel with the title and one row per id", () => {
    const ids = seedMany(3);
    const { getByText, getAllByTestId } = render(
      <ActiveAcpRunsOverlay acpRunIds={ids} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /active runs/i }));

    expect(
      screen
        .getByRole("button", { name: /active runs/i })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(getByText("3 Active Runs")).toBeTruthy();
    expect(getAllByTestId("acp-run-inline-progress-card").length).toBe(3);
  });

  test("uses the singular noun when exactly one run is active", () => {
    const ids = seedMany(1);
    render(<ActiveAcpRunsOverlay acpRunIds={ids} />);

    fireEvent.click(screen.getByRole("button", { name: /active runs/i }));

    expect(screen.getByText("1 Active Run")).toBeTruthy();
    expect(screen.queryByText("1 Active Runs")).toBeNull();
  });

  test("clicking a row invokes onAcpRunClick", () => {
    const ids = seedMany(2);
    const opened: string[] = [];
    const { getAllByRole } = render(
      <ActiveAcpRunsOverlay
        acpRunIds={ids}
        onAcpRunClick={(id) => opened.push(id)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /active runs/i }));
    fireEvent.click(getAllByRole("button", { name: /open run/i })[1]);
    expect(opened).toEqual(["acp-1"]);
  });
});

describe("ActiveAcpRunsOverlay — dismissal", () => {
  test("Escape collapses the open panel", async () => {
    const ids = seedMany(2);
    const { queryByText } = render(<ActiveAcpRunsOverlay acpRunIds={ids} />);

    fireEvent.click(screen.getByRole("button", { name: /active runs/i }));
    expect(queryByText("2 Active Runs")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    // The dropdown animates out via AnimatePresence, so it lingers for the
    // exit animation before unmounting.
    await waitFor(() => expect(queryByText("2 Active Runs")).toBeNull(), {
      timeout: 4000,
    });
  });

  test("pointerdown outside the container collapses the open panel", async () => {
    const ids = seedMany(2);
    const { queryByText } = render(<ActiveAcpRunsOverlay acpRunIds={ids} />);

    fireEvent.click(screen.getByRole("button", { name: /active runs/i }));
    expect(queryByText("2 Active Runs")).toBeTruthy();

    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(queryByText("2 Active Runs")).toBeNull(), {
      timeout: 4000,
    });
  });

  test("collapses when the run set drains to 0", () => {
    const ids = seedMany(2);
    const { rerender, queryByText, queryByTestId } = render(
      <ActiveAcpRunsOverlay acpRunIds={ids} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /active runs/i }));
    expect(queryByText("2 Active Runs")).toBeTruthy();

    rerender(<ActiveAcpRunsOverlay acpRunIds={[]} />);
    expect(queryByTestId("active-acp-runs-overlay")).toBeNull();
  });
});
