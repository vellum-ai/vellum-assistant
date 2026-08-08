/**
 * Tests for `ConversationActivityPill`, the header control that reopens the
 * current conversation's subagent and ACP sessions.
 *
 * The detailed per-status card matrix belongs to the descriptor/card tests; what
 * is pinned down here is the control's own contract: when it exists at all, what
 * the trigger claims, which rows it lists, and which of them may be stopped.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const isMobileRef = { value: false };

mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => isMobileRef.value,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));

const isTouchMobileRef = { value: false };

mock.module("@/hooks/use-touch-mobile", () => ({
  useTouchMobile: () => isTouchMobileRef.value,
  TOUCH_MOBILE_MEDIA_QUERY: "(width < 48rem) and (pointer: coarse)",
}));

const {
  ConversationActivityPill,
  ACTIVITY_PILL_TESTID,
  RUNNING_GROUP_TESTID,
  COMPLETED_GROUP_TESTID,
} = await import("@/domains/chat/components/conversation-activity-pill");
const { useSubagentStore } = await import("@/domains/chat/subagent-store");
const { useAcpRunStore } = await import("@/domains/chat/acp-run-store");
const { useViewerStore } = await import("@/stores/viewer-store");
const { useResolvedAssistantsStore } = await import(
  "@/stores/resolved-assistants-store"
);

const CONV = "conv-A";
const OTHER = "conv-B";
const T0 = 1_700_000_000_000;

const openProcessDetail =
  mock<(ref: { kind: string; id: string }) => void>(() => {});
const abortSubagent = mock(async (_id: string) => {});

beforeEach(() => {
  openProcessDetail.mockClear();
  abortSubagent.mockClear();
  useViewerStore.setState({ openProcessDetail });
  useSubagentStore.setState({ abortSubagent });
});

afterEach(() => {
  cleanup();
  useSubagentStore.getState().reset();
  useAcpRunStore.getState().reset();
  isMobileRef.value = false;
  isTouchMobileRef.value = false;
});

/**
 * A running subagent with a timeline, so its card projects as `loading` rather
 * than sitting in the detail-fetch placeholder.
 */
function spawnRunningSubagent(id: string, parentConversationId = CONV) {
  useSubagentStore.getState().spawnSubagent({
    subagentId: id,
    label: id,
    objective: "",
    status: "running",
    conversationId: `${id}-child`,
    parentConversationId,
    timestamp: T0,
  });
  useSubagentStore.getState().loadDetail({
    subagentId: id,
    events: [
      {
        id: `${id}-e1`,
        type: "text",
        content: "working",
        timestamp: T0,
      },
    ],
  });
}

/**
 * A finished subagent whose timeline has NOT been fetched. This is the case that
 * projects a `loading` card state despite being terminal (see
 * `use-subagent-card-data`), so it is the one that proves the stop button is
 * gated on real status rather than on the card's visual state.
 */
function spawnUnfetchedCompletedSubagent(id: string) {
  useSubagentStore.getState().spawnSubagent({
    subagentId: id,
    label: id,
    objective: "",
    status: "completed",
    conversationId: `${id}-child`,
    parentConversationId: CONV,
    timestamp: T0 + 10,
  });
}

function spawnAcpRun(id: string, parentConversationId = CONV, terminal = false) {
  useAcpRunStore.getState().spawnRun({
    acpSessionId: id,
    agent: "claude",
    parentConversationId,
    startedAt: T0 + 20,
  });
  if (terminal) {
    useAcpRunStore.getState().setTerminal({
      acpSessionId: id,
      status: "completed",
      completedAt: T0 + 30,
    });
  }
}

function renderPill(conversationId = CONV) {
  return render(<ConversationActivityPill conversationId={conversationId} />);
}

/** Open the popover / sheet by clicking the trigger. */
function openPanel() {
  fireEvent.click(screen.getByTestId(ACTIVITY_PILL_TESTID));
}

describe("ConversationActivityPill: when it renders", () => {
  test("renders nothing when the conversation has no activity", () => {
    renderPill();
    expect(screen.queryByTestId(ACTIVITY_PILL_TESTID)).toBeNull();
  });

  test("renders nothing when the only activity belongs to another conversation", () => {
    spawnRunningSubagent("sa-theirs", OTHER);
    spawnAcpRun("acp-theirs", OTHER);

    renderPill();

    expect(screen.queryByTestId(ACTIVITY_PILL_TESTID)).toBeNull();
  });

  test("appears once the conversation has activity", () => {
    spawnRunningSubagent("sa-1");
    renderPill();
    expect(screen.getByTestId(ACTIVITY_PILL_TESTID)).toBeTruthy();
  });
});

describe("ConversationActivityPill: trigger", () => {
  test("shows a running group and a finished group side by side", () => {
    spawnRunningSubagent("sa-1");
    spawnUnfetchedCompletedSubagent("sa-done");

    renderPill();

    const trigger = screen.getByTestId(ACTIVITY_PILL_TESTID);
    // Both counts are named for assistive tech; the chips carry it visually.
    expect(trigger.getAttribute("aria-label")).toBe(
      "Conversation activity, 1 running, 1 finished",
    );
    expect(screen.getByTestId(RUNNING_GROUP_TESTID)).toBeTruthy();
    expect(screen.getByTestId(COMPLETED_GROUP_TESTID)).toBeTruthy();
  });

  test("omits the finished group while everything is still running", () => {
    spawnRunningSubagent("sa-1");

    renderPill();

    expect(screen.getByTestId(ACTIVITY_PILL_TESTID).getAttribute("aria-label"))
      .toBe("Conversation activity, 1 running");
    expect(screen.getByTestId(RUNNING_GROUP_TESTID)).toBeTruthy();
    expect(screen.queryByTestId(COMPLETED_GROUP_TESTID)).toBeNull();
  });

  test("omits the running group, and its pulse, once everything has finished", () => {
    spawnUnfetchedCompletedSubagent("sa-done");
    spawnAcpRun("acp-done", CONV, true);

    renderPill();

    expect(screen.getByTestId(ACTIVITY_PILL_TESTID).getAttribute("aria-label"))
      .toBe("Conversation activity, 2 finished");
    expect(screen.queryByTestId(RUNNING_GROUP_TESTID)).toBeNull();
    expect(screen.getByTestId(COMPLETED_GROUP_TESTID)).toBeTruthy();
  });

  test("mixes both kinds inside one status group rather than splitting by kind", () => {
    // The running group holds an ACP run AND a subagent: grouping is by status,
    // never by process kind.
    spawnRunningSubagent("sa-live");
    spawnAcpRun("acp-live");

    renderPill();

    const group = screen.getByTestId(RUNNING_GROUP_TESTID);
    expect(group.querySelectorAll("img, svg").length).toBeGreaterThan(1);
    expect(screen.getByTestId(ACTIVITY_PILL_TESTID).getAttribute("aria-label"))
      .toBe("Conversation activity, 2 running");
  });
});

describe("ConversationActivityPill: panel", () => {
  test("lists this conversation's sessions and not another's", () => {
    spawnRunningSubagent("sa-mine");
    spawnRunningSubagent("sa-theirs", OTHER);

    renderPill();
    openPanel();

    expect(screen.getByTestId("activity-row-sa-mine")).toBeTruthy();
    expect(screen.queryByTestId("activity-row-sa-theirs")).toBeNull();
  });

  test("shows running and completed work together", () => {
    spawnRunningSubagent("sa-live");
    spawnAcpRun("acp-done", CONV, true);

    renderPill();
    openPanel();

    expect(screen.getByTestId("activity-row-sa-live")).toBeTruthy();
    expect(screen.getByTestId("activity-row-acp-done")).toBeTruthy();
  });

  test("opening a row routes to the existing process detail viewer", () => {
    spawnRunningSubagent("sa-live");

    renderPill();
    openPanel();
    fireEvent.click(screen.getByLabelText("Open subagent"));

    expect(openProcessDetail).toHaveBeenCalledWith({
      kind: "subagent",
      id: "sa-live",
    });
  });
});

describe("ConversationActivityPill: stop", () => {
  test("a running row can be stopped", () => {
    spawnRunningSubagent("sa-live");

    renderPill();
    openPanel();
    const row = screen.getByTestId("activity-row-sa-live");
    const stop = row.querySelector('[data-testid="inline-process-card-stop"]');
    expect(stop).toBeTruthy();

    fireEvent.click(stop as Element);
    expect(abortSubagent).toHaveBeenCalledWith("sa-live");
  });

  test("a finished row offers no stop, even while its card still reads as loading", () => {
    // `sa-done` is terminal but its timeline hasn't been fetched, so the shared
    // card projects `state: "loading"`. `InlineProcessCard` keys its stop button
    // off that state, so a row trusting the projection would show Stop on
    // already-finished work.
    spawnUnfetchedCompletedSubagent("sa-done");

    renderPill();
    openPanel();
    const row = screen.getByTestId("activity-row-sa-done");

    expect(
      row.querySelector('[data-testid="inline-process-card-stop"]'),
    ).toBeNull();
  });
});

describe("ConversationActivityPill: detail demand", () => {
  // The regression this pins: a finished row whose timeline was never
  // streamed projects as "Loading" until fetched, and this panel has no fetch
  // trigger of its own. The demand lives in `useSubagentCardData` (rendering
  // a row IS the fetch trigger), so opening the panel must fetch, and the
  // trigger chips alone must not.

  test("opening the panel fetches timelines for finished rows that never streamed theirs", () => {
    useResolvedAssistantsStore.getState().setActiveAssistantId("assistant-1");
    spawnUnfetchedCompletedSubagent("sa-done");
    const spy = spyOn(
      useSubagentStore.getState(),
      "fetchDetailIfNeeded",
    ).mockImplementation(async () => {});

    renderPill();
    // The closed trigger renders avatar chips only: no card data, no fetch.
    expect(spy).not.toHaveBeenCalled();

    openPanel();
    expect(spy).toHaveBeenCalledWith("assistant-1", "sa-done");

    spy.mockRestore();
    useResolvedAssistantsStore.getState().setActiveAssistantId(null);
  });

  test("a finished row whose timeline is already loaded demands nothing", () => {
    useResolvedAssistantsStore.getState().setActiveAssistantId("assistant-1");
    spawnUnfetchedCompletedSubagent("sa-done");
    useSubagentStore.getState().loadDetail({
      subagentId: "sa-done",
      events: [
        { id: "sa-done-e1", type: "text", content: "did it", timestamp: T0 },
      ],
    });
    const spy = spyOn(
      useSubagentStore.getState(),
      "fetchDetailIfNeeded",
    ).mockImplementation(async () => {});

    renderPill();
    openPanel();

    expect(spy).not.toHaveBeenCalled();

    spy.mockRestore();
    useResolvedAssistantsStore.getState().setActiveAssistantId(null);
  });
});

describe("ConversationActivityPill: mobile", () => {
  test("uses the icon-only trigger and opens the bottom sheet", () => {
    isMobileRef.value = true;
    isTouchMobileRef.value = true;
    spawnRunningSubagent("sa-live");

    renderPill();
    const trigger = screen.getByTestId(ACTIVITY_PILL_TESTID);
    expect(trigger.getAttribute("aria-label")).toBe(
      "Conversation activity, 1 running",
    );
    expect(screen.getByTestId(RUNNING_GROUP_TESTID)).toBeTruthy();

    fireEvent.click(trigger);
    expect(screen.getByTestId("activity-row-sa-live")).toBeTruthy();
  });
});
