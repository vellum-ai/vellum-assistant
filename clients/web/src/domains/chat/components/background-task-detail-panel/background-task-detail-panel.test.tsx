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
  test("renders title, command, status, exit code, and output for a terminal task", () => {
    render(<BackgroundTaskDetailPanel entry={makeEntry()} onClose={noop} />);
    // Title is the status label; the command lives only in the code block.
    expect(screen.getByText("Command finished")).toBeDefined();
    expect(screen.getByText("npm run build")).toBeDefined();
    expect(screen.getByText("Completed")).toBeDefined();
    expect(screen.getByText("Exit code: 0")).toBeDefined();
    expect(screen.getByText("Build succeeded in 4.2s")).toBeDefined();
    // A settled task offers no Stop control.
    expect(screen.queryByLabelText("Stop command")).toBeNull();
  });

  test("renders a non-zero exit code for a failed task", () => {
    render(
      <BackgroundTaskDetailPanel
        entry={makeEntry({ status: "failed", exitCode: 1 })}
        onClose={noop}
      />,
    );
    expect(screen.getByText("Exit code: 1")).toBeDefined();
  });

  test("shows a Stop button and hides output/exit code while the task is still running", () => {
    render(
      <BackgroundTaskDetailPanel
        entry={makeEntry({ status: "running", output: undefined })}
        onClose={noop}
      />,
    );
    expect(screen.getByText("Running command")).toBeDefined();
    expect(screen.getByText("Running")).toBeDefined();
    expect(screen.getByLabelText("Stop command")).toBeDefined();
    expect(screen.queryByText("Output")).toBeNull();
    expect(screen.queryByText(/Exit code:/)).toBeNull();
  });

  test("omits the exit-code line when none was captured", () => {
    render(
      <BackgroundTaskDetailPanel
        entry={makeEntry({ status: "cancelled", exitCode: null })}
        onClose={noop}
      />,
    );
    expect(screen.queryByText(/Exit code:/)).toBeNull();
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
