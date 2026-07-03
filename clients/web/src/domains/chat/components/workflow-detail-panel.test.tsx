/**
 * The detail panel renders the run header (icon tile + label + status badge),
 * a metrics row, an Objective section, and a live "Subagents" list. Each
 * subagent row is keyed by `seq` and shows a lead indicator that resolves in
 * place — a three-dot pulse while running, a status glyph once terminal — the
 * leaf's task name, and its latest activity. The panel asks its host to fetch
 * the journal on open and again when the run reaches a terminal state,
 * reconciling leaves a dropped SSE event left stale.
 */

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

mock.module("@/domains/chat/components/workflow-status-badge", () => ({
  WorkflowStatusBadge: ({ status }: { status: string }) => (
    <div data-testid="status-badge" data-status={status} />
  ),
  WorkflowLeafStatusBadge: ({ status }: { status: string }) => (
    <div data-testid="leaf-status-badge" data-status={status} />
  ),
}));

// Stub the avatar renderer so rows don't depend on the lazily-imported bundled
// SVG chunk. (Mock the renderer, not `useBundledAvatarComponents` — Bun module
// mocks are process-global and survive `mock.restore()`, so mocking the hook
// here would leak into other files' tests that rely on the real one.)
mock.module("@/components/avatar-renderer", () => ({
  AvatarRenderer: () => <div data-testid="avatar" />,
}));

import { WorkflowDetailPanel } from "@/domains/chat/components/workflow-detail-panel";
import type {
  WorkflowEntry,
  WorkflowLeaf,
} from "@/domains/chat/workflow-store";

const noop = () => {};

function makeLeaf(overrides: Partial<WorkflowLeaf> & { seq: number }): WorkflowLeaf {
  return {
    status: "running",
    ...overrides,
  };
}

function makeEntry(overrides: Partial<WorkflowEntry> = {}): WorkflowEntry {
  return {
    runId: "run-1",
    label: "Research workflow",
    status: "running",
    agentsSpawned: 0,
    inputTokens: 0,
    outputTokens: 0,
    startedAt: Date.now(),
    leaves: new Map(),
    ...overrides,
  };
}

function leafMap(leaves: WorkflowLeaf[]): Map<number, WorkflowLeaf> {
  return new Map(leaves.map((leaf) => [leaf.seq, leaf]));
}

afterEach(() => {
  cleanup();
});
afterAll(() => {
  mock.restore();
});

describe("WorkflowDetailPanel", () => {
  test("renders the header label and status badge", () => {
    render(
      <WorkflowDetailPanel
        entry={makeEntry({ label: "Research workflow", status: "running" })}
        onClose={noop}
      />,
    );

    expect(screen.getByText("Research workflow")).toBeDefined();
    const badge = screen.getByTestId("status-badge");
    expect(badge.getAttribute("data-status")).toBe("running");
  });

  test("falls back to the runId when no label is set", () => {
    render(
      <WorkflowDetailPanel
        entry={makeEntry({ label: undefined, runId: "run-xyz" })}
        onClose={noop}
      />,
    );

    expect(screen.getByText("run-xyz")).toBeDefined();
  });

  test("renders one row per leaf with task name, activity, and a running indicator", () => {
    const { container } = render(
      <WorkflowDetailPanel
        entry={makeEntry({
          leaves: leafMap([
            makeLeaf({
              seq: 0,
              label: "Running leaf",
              promptSummary: "Searching the web",
              status: "running",
            }),
            makeLeaf({ seq: 1, label: "Done leaf", status: "completed" }),
            makeLeaf({ seq: 2, label: "Broken leaf", status: "failed" }),
          ]),
        })}
        onClose={noop}
      />,
    );

    expect(screen.getByText("Running leaf")).toBeDefined();
    expect(screen.getByText("Done leaf")).toBeDefined();
    expect(screen.getByText("Broken leaf")).toBeDefined();
    // The running leaf's latest activity renders after the divider.
    expect(screen.getByText("Searching the web")).toBeDefined();

    // Exactly one leaf is running, so the three-dot running indicator (3 dots)
    // appears once; the terminal leaves show a static status icon instead of a
    // spinner.
    expect(container.querySelectorAll(".busy-indicator").length).toBe(3);
    expect(container.querySelectorAll(".animate-spin").length).toBe(0);
  });

  test("renders the neutral cancelled icon for a cancelled leaf", () => {
    const { container } = render(
      <WorkflowDetailPanel
        entry={makeEntry({
          leaves: leafMap([
            makeLeaf({ seq: 0, label: "Cancelled leaf", status: "cancelled" }),
          ]),
        })}
        onClose={noop}
      />,
    );

    // The cancelled icon carries an accessible "Cancelled" label and is not the
    // running indicator.
    expect(screen.getByLabelText("Cancelled")).toBeDefined();
    expect(container.querySelectorAll(".busy-indicator").length).toBe(0);
  });

  test("shows an empty state when there are no subagents yet", () => {
    render(<WorkflowDetailPanel entry={makeEntry({ leaves: new Map() })} onClose={noop} />);
    expect(screen.getByText("No subagents yet")).toBeDefined();
  });

  test("clicking a subagent row opens its detail with separate Prompt and Result sections", () => {
    render(
      <WorkflowDetailPanel
        entry={makeEntry({
          leaves: leafMap([
            makeLeaf({
              seq: 0,
              label: "Research leaf",
              status: "completed",
              promptSummary: "Search the web for X",
              resultSummary: "Found three sources",
            }),
          ]),
        })}
        onClose={noop}
      />,
    );

    // List view first — no Prompt/Result sections, no breadcrumb back.
    expect(screen.getByText("Subagents")).toBeDefined();
    expect(screen.queryByText("Prompt")).toBeNull();
    expect(screen.queryByLabelText("Back to subagents")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Open Research leaf details" }),
    );

    // Detail view: prompt and result render as two separate, labeled sections.
    expect(screen.getByText("Prompt")).toBeDefined();
    expect(screen.getByText("Search the web for X")).toBeDefined();
    expect(screen.getByText("Result")).toBeDefined();
    expect(screen.getByText("Found three sources")).toBeDefined();
    // The breadcrumb back affordance appears; the list is gone.
    expect(screen.getByLabelText("Back to subagents")).toBeDefined();
    expect(screen.queryByText("Subagents")).toBeNull();
  });

  test("the drilled-in leaf header shows the leaf's status, not the parent workflow's", () => {
    render(
      <WorkflowDetailPanel
        entry={makeEntry({
          status: "running",
          leaves: leafMap([
            makeLeaf({ seq: 0, label: "Failed leaf", status: "failed" }),
          ]),
        })}
        onClose={noop}
      />,
    );

    // List view: the badge reflects the (running) parent workflow.
    expect(screen.getByTestId("status-badge").getAttribute("data-status")).toBe(
      "running",
    );
    expect(screen.queryByTestId("leaf-status-badge")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Open Failed leaf details" }),
    );

    // Leaf view: the badge reflects the selected leaf (failed), and the parent
    // workflow badge is gone.
    expect(
      screen.getByTestId("leaf-status-badge").getAttribute("data-status"),
    ).toBe("failed");
    expect(screen.queryByTestId("status-badge")).toBeNull();
  });

  test("Back returns from a leaf detail to the subagents list", () => {
    render(
      <WorkflowDetailPanel
        entry={makeEntry({
          leaves: leafMap([
            makeLeaf({
              seq: 0,
              label: "Research leaf",
              status: "completed",
              resultSummary: "done",
            }),
          ]),
        })}
        onClose={noop}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Open Research leaf details" }),
    );
    expect(screen.getByText("Prompt")).toBeDefined();

    fireEvent.click(screen.getByLabelText("Back to subagents"));
    expect(screen.getByText("Subagents")).toBeDefined();
    expect(screen.queryByText("Prompt")).toBeNull();
  });

  test("a running leaf with no result shows a running state in the Result section", () => {
    render(
      <WorkflowDetailPanel
        entry={makeEntry({
          leaves: leafMap([
            makeLeaf({
              seq: 0,
              label: "Busy leaf",
              status: "running",
              promptSummary: "Working on it",
            }),
          ]),
        })}
        onClose={noop}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Open Busy leaf details" }),
    );
    expect(screen.getByText("Working on it")).toBeDefined();
    expect(screen.getByText("Running…")).toBeDefined();
  });

  test("requests the journal on open even when leaves are already present", () => {
    const requested: string[] = [];
    render(
      <WorkflowDetailPanel
        entry={makeEntry({
          runId: "run-open",
          leaves: leafMap([makeLeaf({ seq: 0 })]),
        })}
        onClose={noop}
        onRequestJournal={(runId) => {
          requested.push(runId);
        }}
      />,
    );

    expect(requested).toEqual(["run-open"]);
  });

  test("requests the journal again when the run transitions to terminal", () => {
    const requested: string[] = [];
    const onRequestJournal = (runId: string) => {
      requested.push(runId);
    };
    const { rerender } = render(
      <WorkflowDetailPanel
        entry={makeEntry({ runId: "run-final", status: "running" })}
        onClose={noop}
        onRequestJournal={onRequestJournal}
      />,
    );
    expect(requested).toEqual(["run-final"]);

    rerender(
      <WorkflowDetailPanel
        entry={makeEntry({ runId: "run-final", status: "completed" })}
        onClose={noop}
        onRequestJournal={onRequestJournal}
      />,
    );
    // One fetch on open (live) + one on the live→terminal transition.
    expect(requested).toEqual(["run-final", "run-final"]);
  });

  test("does not re-request the journal across renders within the same phase", () => {
    const requested: string[] = [];
    const onRequestJournal = (runId: string) => {
      requested.push(runId);
    };
    const { rerender } = render(
      <WorkflowDetailPanel
        entry={makeEntry({ runId: "run-stable", status: "running" })}
        onClose={noop}
        onRequestJournal={onRequestJournal}
      />,
    );

    rerender(
      <WorkflowDetailPanel
        entry={makeEntry({
          runId: "run-stable",
          status: "running",
          leaves: leafMap([makeLeaf({ seq: 0 })]),
        })}
        onClose={noop}
        onRequestJournal={onRequestJournal}
      />,
    );

    // Same run, same (live) phase — the effect's deps are unchanged.
    expect(requested).toEqual(["run-stable"]);
  });

  test("shows the Stop button only for an active run", () => {
    const { rerender } = render(
      <WorkflowDetailPanel
        entry={makeEntry({ status: "running" })}
        onClose={noop}
        onStop={noop}
      />,
    );
    expect(screen.queryByLabelText("Stop workflow")).not.toBeNull();

    rerender(
      <WorkflowDetailPanel
        entry={makeEntry({ status: "completed" })}
        onClose={noop}
        onStop={noop}
      />,
    );
    expect(screen.queryByLabelText("Stop workflow")).toBeNull();
  });
});
