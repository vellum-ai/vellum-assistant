import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const confirmationSubmits: { decision: string; toolCallId?: string }[] = [];
mock.module("@/domains/chat/confirmation-actions", () => ({
  handleConfirmationSubmit: (decision: string, toolCall?: { id: string }) => {
    confirmationSubmits.push(
      toolCall === undefined
        ? { decision }
        : { decision, toolCallId: toolCall.id },
    );
    return Promise.resolve();
  },
}));

const secretSubmits: unknown[][] = [];
mock.module("@/domains/chat/secret-actions", () => ({
  handleSecretSubmit: (...args: unknown[]) => {
    secretSubmits.push(args);
    return Promise.resolve();
  },
}));

const surfaceActions: unknown[][] = [];
mock.module("@/domains/chat/surface-actions", () => ({
  handleSurfaceAction: (...args: unknown[]) => {
    surfaceActions.push(args);
    return Promise.resolve();
  },
}));

const settingsOpened: string[] = [];
mock.module("@/runtime/system-permissions", () => ({
  openSystemPermissionSettings: (kind: string) => {
    settingsOpened.push(kind);
    return Promise.resolve(null);
  },
}));

const { answerCompanionPopover } =
  await import("@/domains/chat/companion-popover-actions");
const { useChatSessionStore } =
  await import("@/domains/chat/chat-session-store");
const { offerSurfaceToCompanion, useCompanionPopoverStore } =
  await import("@/domains/chat/companion-popover");
const { useInteractionStore } =
  await import("@/domains/chat/interaction-store");

const seed = (message: Record<string, unknown>): void => {
  useChatSessionStore.setState({
    snapshot: { messages: [{ id: "msg-1", role: "assistant", ...message }] },
    dismissedSurfaceIds: new Set(),
  } as never);
};

/** Two approvals pending at once, each on its own tool call. */
const seedTwoApprovals = (): void => {
  seed({
    toolCalls: [
      {
        id: "tc-1",
        name: "bash",
        input: { command: "ls" },
        pendingConfirmation: { requestId: "req-1", toolName: "bash" },
      },
      {
        id: "tc-2",
        name: "request_system_permission",
        input: { permission_type: "accessibility" },
        pendingConfirmation: {
          requestId: "req-2",
          toolName: "request_system_permission",
          input: { permission_type: "accessibility" },
        },
      },
    ],
  });
};

const seedCard = (): void => {
  seed({
    surfaces: [
      {
        surfaceId: "surf-1",
        surfaceType: "card",
        data: { title: "Pick a time" },
        actions: [{ id: "tomorrow", label: "Tomorrow", data: { day: 1 } }],
      },
    ],
  });
  offerSurfaceToCompanion("surf-1");
};

beforeEach(() => {
  confirmationSubmits.length = 0;
  secretSubmits.length = 0;
  surfaceActions.length = 0;
  settingsOpened.length = 0;
  useInteractionStore.getState().resetAll();
  useCompanionPopoverStore.setState({ offeredSurfaceId: null });
});

afterEach(() => {
  useChatSessionStore.setState({ snapshot: null });
});

describe("a press on the companion's popover", () => {
  test("answers each approval on the tool call it belongs to", async () => {
    seedTwoApprovals();

    await answerCompanionPopover("req-1,req-2", {
      kind: "deny",
      itemId: "req-1",
    });

    expect(confirmationSubmits).toEqual([
      { decision: "deny", toolCallId: "tc-1" },
    ]);
  });

  /** A new approval joining the list changes its id, not the row's. */
  test("lands an approval's answer after the list around it changed", async () => {
    seedTwoApprovals();

    await answerCompanionPopover("req-1", { kind: "allow", itemId: "req-1" });

    expect(confirmationSubmits).toEqual([
      { decision: "allow", toolCallId: "tc-1" },
    ]);
  });

  test("allows a permission request and opens its pane", async () => {
    seedTwoApprovals();

    await answerCompanionPopover("req-1,req-2", {
      kind: "settings",
      itemId: "req-2",
    });

    expect(confirmationSubmits).toEqual([
      { decision: "allow", toolCallId: "tc-2" },
    ]);
    expect(settingsOpened).toEqual(["accessibility"]);
  });

  test("answers the store's approval when no tool call carries it", async () => {
    useInteractionStore
      .getState()
      .showConfirmation({ requestId: "req-9", toolName: "bash" });

    await answerCompanionPopover("req-9", { kind: "allow", itemId: "req-9" });

    expect(confirmationSubmits).toEqual([{ decision: "allow" }]);
  });

  test("drops an answer for an approval no longer pending", async () => {
    seedTwoApprovals();

    await answerCompanionPopover("req-1,req-2", {
      kind: "allow",
      itemId: "req-7",
    });

    expect(confirmationSubmits).toEqual([]);
  });

  test("sends a credential for the request on screen", async () => {
    useInteractionStore
      .getState()
      .showSecret({ requestId: "sec-1", service: "Booking.com" });

    await answerCompanionPopover("sec-1", { kind: "secret", value: "hunter2" });

    expect(secretSubmits).toEqual([["hunter2", "store"]]);
  });

  test("sends no credential for a request that was replaced", async () => {
    useInteractionStore
      .getState()
      .showSecret({ requestId: "sec-2", service: "Booking.com" });

    await answerCompanionPopover("sec-1", { kind: "secret", value: "hunter2" });

    expect(secretSubmits).toEqual([]);
  });

  test("runs a card's action with the action's own data", async () => {
    seedCard();

    await answerCompanionPopover("surf-1", {
      kind: "action",
      actionId: "tomorrow",
    });

    expect(surfaceActions).toEqual([["surf-1", "tomorrow", { day: 1 }]]);
  });

  /** A second press that crossed the first on its way here. */
  test("posts a card's action once while its submission is in flight", async () => {
    seedCard();
    // Not awaited: the first submission is still out when the second arrives.
    const first = answerCompanionPopover("surf-1", {
      kind: "action",
      actionId: "tomorrow",
    });
    await answerCompanionPopover("surf-1", {
      kind: "action",
      actionId: "tomorrow",
    });
    await first;

    expect(surfaceActions).toHaveLength(1);
  });

  test("does nothing for an action the card does not carry", async () => {
    seedCard();

    await answerCompanionPopover("surf-1", {
      kind: "action",
      actionId: "yesterday",
    });

    expect(surfaceActions).toEqual([]);
  });

  test("a dismissal stops offering the surface", async () => {
    seedCard();

    await answerCompanionPopover("surf-1", { kind: "dismiss" });

    expect(useCompanionPopoverStore.getState().offeredSurfaceId).toBeNull();
    expect(surfaceActions).toEqual([]);
  });
});
