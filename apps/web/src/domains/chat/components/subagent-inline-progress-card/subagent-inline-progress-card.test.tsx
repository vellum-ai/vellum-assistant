/**
 * Tests for `SubagentInlineProgressCard`.
 *
 * Drives the Zustand subagent store with fixture timelines and asserts
 * the rendered shell's title/info/pill transitions, the spawn-race
 * `null` fallback, and the deterministic avatar trait variation across
 * subagent IDs.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { SubagentInlineProgressCard } from "@/domains/chat/components/subagent-inline-progress-card/subagent-inline-progress-card";
import { useSubagentStore } from "@/domains/chat/subagent-store";

const NOW = 1700000000000;

beforeEach(() => {
  useSubagentStore.getState().reset();
});

afterEach(() => {
  cleanup();
});

function spawn(id: string, label = "Research Agent") {
  useSubagentStore.getState().spawnSubagent({
    subagentId: id,
    label,
    objective: "Find the answer",
    timestamp: NOW,
  });
  useSubagentStore.getState().changeStatus({
    subagentId: id,
    status: "running",
  });
}

describe("SubagentInlineProgressCard — spawn race", () => {
  test("renders null when no entry exists in the store yet", () => {
    const { container } = render(
      <SubagentInlineProgressCard subagentId="missing" />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe("SubagentInlineProgressCard — fixture timeline", () => {
  test("shows Thinking title with text preview while a text event is the latest", () => {
    spawn("sa-1");
    useSubagentStore.getState().receiveEvent({
      subagentId: "sa-1",
      event: { type: "assistant_text_delta", text: "Checking the docs" },
      timestamp: NOW + 100,
    });

    const { getByText, getByTestId, queryByText } = render(
      <SubagentInlineProgressCard subagentId="sa-1" />,
    );

    expect(getByText("Thinking")).toBeTruthy();
    expect(getByText("Checking the docs")).toBeTruthy();
    // Single-step cards suppress the count pill — it only shows for 2+.
    expect(queryByText("1 step")).toBeNull();
    expect(getByTestId("subagent-inline-card-shell")).toBeTruthy();
  });

  test("transitions to Working when a tool_call lands after text", () => {
    spawn("sa-2");
    const store = useSubagentStore.getState();
    store.receiveEvent({
      subagentId: "sa-2",
      event: { type: "assistant_text_delta", text: "Searching" },
      timestamp: NOW + 100,
    });
    store.receiveEvent({
      subagentId: "sa-2",
      event: {
        type: "tool_use_start",
        toolName: "bash",
        input: { command: "ls -la" },
      },
      timestamp: NOW + 200,
    });

    const { getByText } = render(
      <SubagentInlineProgressCard subagentId="sa-2" />,
    );
    expect(getByText("Working")).toBeTruthy();
    expect(getByText("ls -la")).toBeTruthy();
    expect(getByText("2 steps")).toBeTruthy();
  });

  test("renders Used <Tool> when subagent reaches completed after a tool_result", () => {
    spawn("sa-3");
    const store = useSubagentStore.getState();
    store.receiveEvent({
      subagentId: "sa-3",
      event: {
        type: "tool_use_start",
        toolName: "file_read",
        input: { file_path: "/etc/hosts" },
      },
      timestamp: NOW + 100,
    });
    store.receiveEvent({
      subagentId: "sa-3",
      event: {
        type: "tool_result",
        toolName: "file_read",
        result: "127.0.0.1 localhost",
      },
      timestamp: NOW + 2200,
    });
    store.changeStatus({ subagentId: "sa-3", status: "completed" });

    const { getByText, queryByText } = render(
      <SubagentInlineProgressCard subagentId="sa-3" />,
    );
    expect(getByText("Used File Read")).toBeTruthy();
    // Single-step cards suppress the count pill.
    expect(queryByText("1 step")).toBeNull();
  });

  test("renders the deterministic avatar in the leading slot", () => {
    spawn("sa-avatar");
    const { container } = render(
      <SubagentInlineProgressCard subagentId="sa-avatar" />,
    );
    expect(
      container.querySelector('[aria-label="Subagent sa-avatar"]'),
    ).not.toBeNull();
  });
});

describe("SubagentInlineProgressCard — header action", () => {
  test("clicking the header row invokes onSubagentClick", () => {
    spawn("sa-open");
    const seen: string[] = [];
    const { getByRole } = render(
      <SubagentInlineProgressCard
        subagentId="sa-open"
        onSubagentClick={(id) => seen.push(id)}
      />,
    );
    // The whole header row IS the open affordance — no separate icon
    // button anymore. The shell uses the aria-label we passed through.
    fireEvent.click(getByRole("button", { name: /open subagent/i }));
    expect(seen).toEqual(["sa-open"]);
  });

  test("no expand toggle is exposed — there is no inline body", () => {
    spawn("sa-no-expand");
    act(() => {
      useSubagentStore.getState().receiveEvent({
        subagentId: "sa-no-expand",
        event: { type: "assistant_text_delta", text: "reasoning" },
        timestamp: NOW + 100,
      });
    });
    const { queryByRole } = render(
      <SubagentInlineProgressCard
        subagentId="sa-no-expand"
        onSubagentClick={() => {}}
      />,
    );
    expect(queryByRole("button", { name: /expand steps/i })).toBeNull();
    expect(queryByRole("button", { name: /collapse steps/i })).toBeNull();
  });

  test("stop button only renders while the subagent is in-flight", () => {
    spawn("sa-stop");
    const seen: string[] = [];
    const { getByTestId, queryByTestId } = render(
      <SubagentInlineProgressCard
        subagentId="sa-stop"
        onStopSubagent={(id) => seen.push(id)}
      />,
    );
    fireEvent.click(getByTestId("subagent-inline-card-stop"));
    expect(seen).toEqual(["sa-stop"]);

    act(() => {
      useSubagentStore.getState().changeStatus({
        subagentId: "sa-stop",
        status: "completed",
      });
    });
    expect(queryByTestId("subagent-inline-card-stop")).toBeNull();
  });
});

describe("SubagentInlineProgressCard — deterministic avatar traits", () => {
  test("different subagent IDs render different avatar DOM", async () => {
    spawn("sa-trait-a");
    spawn("sa-trait-b-something-different");

    const a = render(<SubagentInlineProgressCard subagentId="sa-trait-a" />);
    const b = render(
      <SubagentInlineProgressCard subagentId="sa-trait-b-something-different" />,
    );

    // `SubagentAvatarChip` lazy-loads the ~48 kB BUNDLED_COMPONENTS payload
    // and renders a transparent placeholder until the chunk resolves; wait
    // for the real SVG before comparing markup.
    await waitFor(() => {
      const svg = a.container.querySelector(
        '[aria-label="Subagent sa-trait-a"] svg',
      );
      expect(svg).not.toBeNull();
    });
    await waitFor(() => {
      const svg = b.container.querySelector(
        '[aria-label="Subagent sa-trait-b-something-different"] svg',
      );
      expect(svg).not.toBeNull();
    });

    // The two avatar SVG markup should differ (deterministic-per-id traits).
    const aAvatar = a.container.querySelector(
      '[aria-label="Subagent sa-trait-a"]',
    );
    const bAvatar = b.container.querySelector(
      '[aria-label="Subagent sa-trait-b-something-different"]',
    );
    expect(aAvatar).not.toBeNull();
    expect(bAvatar).not.toBeNull();
    expect(aAvatar?.innerHTML).not.toBe(bAvatar?.innerHTML);
  });
});
