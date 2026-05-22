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
import { cleanup, fireEvent, render } from "@testing-library/react";

import { SubagentInlineProgressCard } from "@/domains/chat/components/subagent-inline-progress-card/subagent-inline-progress-card.js";
import { useSubagentStore } from "@/domains/subagents/subagent-store.js";

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

    const { getByText, getByTestId } = render(
      <SubagentInlineProgressCard subagentId="sa-1" />,
    );

    expect(getByText("Thinking")).toBeTruthy();
    expect(getByText("Checking the docs")).toBeTruthy();
    expect(getByText("1 step")).toBeTruthy();
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

    const { getByText } = render(
      <SubagentInlineProgressCard subagentId="sa-3" />,
    );
    expect(getByText("Used File Read")).toBeTruthy();
    expect(getByText("1 step")).toBeTruthy();
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

describe("SubagentInlineProgressCard — action rail", () => {
  test("clicking the open button invokes onSubagentClick", () => {
    spawn("sa-open");
    const seen: string[] = [];
    const { getByTestId } = render(
      <SubagentInlineProgressCard
        subagentId="sa-open"
        onSubagentClick={(id) => seen.push(id)}
      />,
    );
    fireEvent.click(getByTestId("subagent-inline-card-open"));
    expect(seen).toEqual(["sa-open"]);
  });

  test("clicking the open button does NOT toggle the shell's expanded state", () => {
    spawn("sa-open-isolation");
    // Give the shell at least one step so disableExpand is false and the
    // body would be reachable on toggle.
    act(() => {
      useSubagentStore.getState().receiveEvent({
        subagentId: "sa-open-isolation",
        event: { type: "assistant_text_delta", text: "reasoning" },
        timestamp: NOW + 100,
      });
    });
    const { getByTestId, queryByRole } = render(
      <SubagentInlineProgressCard
        subagentId="sa-open-isolation"
        onSubagentClick={() => {}}
      />,
    );

    const expandButton = queryByRole("button", { name: /expand steps/i });
    expect(expandButton?.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(getByTestId("subagent-inline-card-open"));

    const stillCollapsed = queryByRole("button", {
      name: /expand steps/i,
    });
    expect(stillCollapsed?.getAttribute("aria-expanded")).toBe("false");
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
  test("different subagent IDs render different avatar DOM", () => {
    spawn("sa-trait-a");
    spawn("sa-trait-b-something-different");

    const a = render(<SubagentInlineProgressCard subagentId="sa-trait-a" />);
    const b = render(
      <SubagentInlineProgressCard subagentId="sa-trait-b-something-different" />,
    );
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
