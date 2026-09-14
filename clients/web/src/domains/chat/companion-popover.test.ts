import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import {
  currentCompanionPopover,
  offerSurfaceToCompanion,
  useCompanionPopoverStore,
  withdrawSurfaceFromCompanion,
} from "@/domains/chat/companion-popover";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import type { DisplayMessage, Surface } from "@/domains/chat/types/types";

const CARD: Surface = {
  surfaceId: "surf-1",
  surfaceType: "card",
  title: "Surface title",
  data: {
    title: "The Eiffel Tower",
    subtitle: "Paris",
    body: "![tower](https://example.com/tower.jpg)\n\n[Tickets](https://example.com/tickets)",
    metadata: [{ label: "Height", value: "330 m" }],
  },
  actions: [
    { id: "book", label: "Book", style: "primary" },
    { id: "later", label: "Later" },
  ],
};

const seed = (surfaces: Surface[]): void => {
  const message = {
    id: "msg-1",
    role: "assistant",
    surfaces,
  } as unknown as DisplayMessage;
  useChatSessionStore.setState({
    snapshot: {
      messages: [message],
    } as unknown as ReturnType<typeof useChatSessionStore.getState>["snapshot"],
    dismissedSurfaceIds: new Set(),
  });
};

beforeEach(() => {
  useInteractionStore.getState().resetAll();
  useCompanionPopoverStore.setState({ offeredSurfaceId: null });
});

afterEach(() => {
  useChatSessionStore.setState({ snapshot: null });
});

describe("what the companion's popover shows", () => {
  test("nothing, with no approval and no surface offered", () => {
    seed([CARD]);

    expect(currentCompanionPopover()).toBeUndefined();
  });

  /** A conversation opened from history does not replay its surfaces. */
  test("a surface only once it has been offered live", () => {
    seed([CARD]);
    offerSurfaceToCompanion("surf-1");

    expect(currentCompanionPopover()).toEqual({
      kind: "card",
      id: "surf-1",
      title: "The Eiffel Tower",
      subtitle: "Paris",
      body: "![tower](https://example.com/tower.jpg)\n\n[Tickets](https://example.com/tickets)\n\n- **Height:** 330 m",
      actions: [
        { id: "book", label: "Book", style: "primary" },
        { id: "later", label: "Later", style: "secondary" },
      ],
    });
  });

  test("nothing once the offered surface is completed", () => {
    seed([{ ...CARD, completed: true }]);
    offerSurfaceToCompanion("surf-1");

    expect(currentCompanionPopover()).toBeUndefined();
  });

  test("nothing once the offered surface is dismissed in the chat", () => {
    seed([CARD]);
    useChatSessionStore.setState({ dismissedSurfaceIds: new Set(["surf-1"]) });
    offerSurfaceToCompanion("surf-1");

    expect(currentCompanionPopover()).toBeUndefined();
  });

  test("nothing once the surface is withdrawn from the popover", () => {
    seed([CARD]);
    offerSurfaceToCompanion("surf-1");

    withdrawSurfaceFromCompanion("surf-1");

    expect(currentCompanionPopover()).toBeUndefined();
  });

  /** Withdrawing an older surface must not take down the one that replaced it. */
  test("withdrawing a surface that was replaced leaves the new one", () => {
    seed([CARD, { ...CARD, surfaceId: "surf-2" }]);
    offerSurfaceToCompanion("surf-1");
    offerSurfaceToCompanion("surf-2");

    withdrawSurfaceFromCompanion("surf-1");

    expect(currentCompanionPopover()?.id).toBe("surf-2");
  });

  test("a surface it cannot draw by name, to open in the app", () => {
    seed([
      {
        surfaceId: "form-1",
        surfaceType: "form",
        title: "Shipping address",
        data: {},
      },
    ]);
    offerSurfaceToCompanion("form-1");

    expect(currentCompanionPopover()).toEqual({
      kind: "surface",
      id: "form-1",
      title: "Shipping address",
    });
  });

  test("a templated card by name, since its renderer is the app's", () => {
    seed([{ ...CARD, data: { ...CARD.data, template: "weather_forecast" } }]);
    offerSurfaceToCompanion("surf-1");

    expect(currentCompanionPopover()?.kind).toBe("surface");
  });

  /** The turn is stopped until the approval is answered. */
  test("the approval ahead of an offered surface", () => {
    seed([CARD]);
    offerSurfaceToCompanion("surf-1");
    useInteractionStore.getState().showConfirmation({
      requestId: "req-1",
      toolName: "bash",
      input: { command: "ls -la", activity: "Listing your files" },
      riskReason: "Reads your home folder",
    });

    expect(currentCompanionPopover()).toEqual({
      kind: "approval",
      id: "req-1",
      title: "Listing your files",
      detail: "Reads your home folder",
    });
  });

  test("the privacy pane a permission request is about", () => {
    useInteractionStore.getState().showConfirmation({
      requestId: "req-2",
      toolName: "request_system_permission",
      input: { permission_type: "screen_recording" },
    });

    const popover = currentCompanionPopover();
    expect(popover?.kind === "approval" ? popover.permission : null).toBe(
      "screen",
    );
  });

  test("no pane for a name that only the object prototype carries", () => {
    useInteractionStore.getState().showConfirmation({
      requestId: "req-4",
      toolName: "request_system_permission",
      input: { permission_type: "constructor" },
    });

    expect(currentCompanionPopover()).not.toHaveProperty("permission");
  });

  test("no pane for a permission the app cannot open", () => {
    useInteractionStore.getState().showConfirmation({
      requestId: "req-3",
      toolName: "request_system_permission",
      input: { permission_type: "full_disk_access" },
    });

    const popover = currentCompanionPopover();
    expect(popover?.kind).toBe("approval");
    expect(popover).not.toHaveProperty("permission");
  });
});
