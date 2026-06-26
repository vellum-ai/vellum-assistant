/**
 * Tests for `ActiveAcpRunsOverlay`.
 *
 * Seeds the Zustand ACP run store with `running` entries for each id (the
 * reused `AcpRunInlineProgressCard` reads the store and renders `null` until
 * the entry lands), then asserts the empty/collapsed/expanded states, the
 * per-row open callback (`openAcpRunDetail`), and Escape / outside-click
 * dismissal.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

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
    expect(
      screen.getByTestId("active-acp-runs-overlay").className,
    ).toContain("pointer-events-none");
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
      screen.getByRole("button", { name: /active runs/i }).getAttribute("aria-expanded"),
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
  test("Escape collapses the open panel", () => {
    const ids = seedMany(2);
    const { queryByText } = render(<ActiveAcpRunsOverlay acpRunIds={ids} />);

    fireEvent.click(screen.getByRole("button", { name: /active runs/i }));
    expect(queryByText("2 Active Runs")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(queryByText("2 Active Runs")).toBeNull();
  });

  test("pointerdown outside the container collapses the open panel", () => {
    const ids = seedMany(2);
    const { queryByText } = render(<ActiveAcpRunsOverlay acpRunIds={ids} />);

    fireEvent.click(screen.getByRole("button", { name: /active runs/i }));
    expect(queryByText("2 Active Runs")).toBeTruthy();

    fireEvent.pointerDown(document.body);
    expect(queryByText("2 Active Runs")).toBeNull();
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
