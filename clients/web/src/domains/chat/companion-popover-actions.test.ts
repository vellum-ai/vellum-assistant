import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const confirmationSubmits: string[] = [];
mock.module("@/domains/chat/confirmation-actions", () => ({
  handleConfirmationSubmit: (decision: string) => {
    confirmationSubmits.push(decision);
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

const seedCard = (): void => {
  useChatSessionStore.setState({
    snapshot: {
      messages: [
        {
          id: "msg-1",
          role: "assistant",
          surfaces: [
            {
              surfaceId: "surf-1",
              surfaceType: "card",
              data: { title: "Pick a time" },
              actions: [
                { id: "tomorrow", label: "Tomorrow", data: { day: 1 } },
              ],
            },
          ],
        },
      ],
    } as never,
    dismissedSurfaceIds: new Set(),
  });
  offerSurfaceToCompanion("surf-1");
};

beforeEach(() => {
  confirmationSubmits.length = 0;
  surfaceActions.length = 0;
  settingsOpened.length = 0;
  useInteractionStore.getState().resetAll();
  useCompanionPopoverStore.setState({ offeredSurfaceId: null });
});

afterEach(() => {
  useChatSessionStore.setState({ snapshot: null });
});

describe("a press on the companion's popover", () => {
  test("allows and denies the approval it shows", async () => {
    useInteractionStore
      .getState()
      .showConfirmation({ requestId: "req-1", toolName: "bash" });

    await answerCompanionPopover("req-1", { kind: "allow" });
    await answerCompanionPopover("req-1", { kind: "deny" });

    expect(confirmationSubmits).toEqual(["allow", "deny"]);
  });

  test("allows a permission request and opens its pane", async () => {
    useInteractionStore.getState().showConfirmation({
      requestId: "req-2",
      toolName: "request_system_permission",
      input: { permission_type: "accessibility" },
    });

    await answerCompanionPopover("req-2", { kind: "settings" });

    expect(confirmationSubmits).toEqual(["allow"]);
    expect(settingsOpened).toEqual(["accessibility"]);
  });

  /** Answered in the app first, or replaced, before the press arrived. */
  test("is dropped when it names what the popover no longer shows", async () => {
    useInteractionStore
      .getState()
      .showConfirmation({ requestId: "req-3", toolName: "bash" });

    await answerCompanionPopover("req-1", { kind: "allow" });

    expect(confirmationSubmits).toEqual([]);
  });

  test("runs a card's action with the action's own data", async () => {
    seedCard();

    await answerCompanionPopover("surf-1", {
      kind: "action",
      actionId: "tomorrow",
    });

    expect(surfaceActions).toEqual([["surf-1", "tomorrow", { day: 1 }]]);
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
