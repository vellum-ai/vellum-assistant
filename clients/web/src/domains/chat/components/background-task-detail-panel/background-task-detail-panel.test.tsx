/**
 * Tests for `BackgroundTaskDetailPanel` — the side-drawer body for a background
 * bash/host_bash task. Asserts it renders the command, status, and (for a
 * terminal task) the captured output, and wires the close handler through.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { BackgroundTaskEntry } from "@/domains/chat/background-task-store";
import { BackgroundTaskDetailPanel } from "@/domains/chat/components/background-task-detail-panel/background-task-detail-panel";

const noop = () => {};

function makeEntry(
  overrides: Partial<BackgroundTaskEntry> = {},
): BackgroundTaskEntry {
  return {
    id: "bg-abc12345",
    toolName: "bash",
    conversationId: "conv-1",
    command: "npm run build",
    startedAt: 0,
    status: "completed",
    exitCode: 0,
    output: "Build succeeded in 4.2s",
    completedAt: 1,
    ...overrides,
  };
}

afterEach(cleanup);

describe("BackgroundTaskDetailPanel", () => {
  test("renders command, status, and output for a terminal task", () => {
    render(<BackgroundTaskDetailPanel entry={makeEntry()} onClose={noop} />);
    // Command appears in both the header title and the command code block.
    expect(screen.getAllByText("npm run build").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Completed")).toBeDefined();
    expect(screen.getByText("Build succeeded in 4.2s")).toBeDefined();
  });

  test("hides the output section while the task is still running", () => {
    render(
      <BackgroundTaskDetailPanel
        entry={makeEntry({ status: "running", output: undefined })}
        onClose={noop}
      />,
    );
    expect(screen.getByText("Running")).toBeDefined();
    expect(screen.queryByText("Output")).toBeNull();
  });

  test("close button fires onClose", () => {
    let closed = 0;
    render(
      <BackgroundTaskDetailPanel
        entry={makeEntry()}
        onClose={() => {
          closed += 1;
        }}
      />,
    );
    fireEvent.click(screen.getByLabelText("Close task detail"));
    expect(closed).toBe(1);
  });
});
