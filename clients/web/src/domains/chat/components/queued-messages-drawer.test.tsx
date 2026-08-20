/**
 * Touch affordances for `QueuedMessagesDrawer`.
 *
 * Every per-row control in the drawer is destructive (cancel and steer remove
 * the message from the queue; edit cancels it and moves its text back into the
 * composer), and the drawer sits directly above the composer where a thumb
 * travels. On a coarse pointer the controls therefore stay behind a reveal tap;
 * on a fine pointer they are always available, exactly as before.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { DisplayMessage } from "@/domains/chat/types/types";
import { QueuedMessagesDrawer } from "@/domains/chat/components/queued-messages-drawer";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

/** The steer button is version-gated, so hydrate an assistant that has it. */
const STEER_CAPABLE_VERSION = "0.8.4";

const originalMatchMedia = window.matchMedia;

function setPointer(coarse: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: coarse && query === "(pointer: coarse)",
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }),
  });
}

function queued(id: string, text: string): DisplayMessage {
  return {
    id,
    role: "user",
    contentBlocks: [{ type: "text", text }],
    queueStatus: "queued",
    queuePosition: 1,
  } as DisplayMessage;
}

const MESSAGES = [queued("m-1", "first queued"), queued("m-2", "second queued")];

function renderDrawer(overrides: Partial<Parameters<typeof QueuedMessagesDrawer>[0]> = {}) {
  const onCancelMessage = mock((_id: string) => {});
  const onSteer = mock((_id: string) => {});
  const onEditTail = mock(() => {});
  render(
    <QueuedMessagesDrawer
      queuedMessages={MESSAGES}
      onCancelMessage={onCancelMessage}
      onCancelAll={() => {}}
      onSteer={onSteer}
      onEditTail={onEditTail}
      {...overrides}
    />,
  );
  return { onCancelMessage, onSteer, onEditTail };
}

/** The row element that owns a given preview, i.e. the reveal tap target. */
function rowFor(text: string): HTMLElement {
  const preview = screen.getByText(text);
  const row = preview.parentElement;
  if (!row) {
    throw new Error(`no row for ${text}`);
  }
  return row;
}

beforeEach(() => {
  useAssistantIdentityStore
    .getState()
    .setIdentity("test-asst", STEER_CAPABLE_VERSION);
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  });
});

describe("QueuedMessagesDrawer: fine pointer", () => {
  beforeEach(() => setPointer(false));

  test("keeps every per-row control available without a reveal step", () => {
    const { onCancelMessage } = renderDrawer();

    expect(screen.queryAllByLabelText("Show queued message actions")).toEqual(
      [],
    );
    const cancels = screen.getAllByLabelText("Cancel queued message");
    expect(cancels.length).toBe(2);
    expect(screen.getAllByLabelText("Push to agent").length).toBe(2);
    // Only the tail is editable.
    expect(screen.getAllByLabelText("Edit queued message").length).toBe(1);

    fireEvent.click(cancels[0]!);
    expect(onCancelMessage).toHaveBeenCalledWith("m-1");
  });
});

describe("QueuedMessagesDrawer: coarse pointer", () => {
  beforeEach(() => setPointer(true));

  test("hides the destructive controls until a row is tapped", () => {
    renderDrawer();

    expect(screen.queryAllByLabelText("Cancel queued message")).toEqual([]);
    expect(screen.queryAllByLabelText("Push to agent")).toEqual([]);
    expect(screen.queryAllByLabelText("Edit queued message")).toEqual([]);
    expect(
      screen.getAllByLabelText("Show queued message actions").length,
    ).toBe(2);
  });

  test("first tap reveals only that row; a second tap activates a control", () => {
    const { onCancelMessage } = renderDrawer();

    fireEvent.click(rowFor("first queued"));
    expect(onCancelMessage).not.toHaveBeenCalled();

    const cancels = screen.getAllByLabelText("Cancel queued message");
    expect(cancels.length).toBe(1);
    // The untapped row keeps its controls hidden.
    expect(
      screen.getAllByLabelText("Show queued message actions").length,
    ).toBe(1);

    fireEvent.click(cancels[0]!);
    expect(onCancelMessage).toHaveBeenCalledWith("m-1");
  });

  test("tapping another row moves the reveal instead of arming both", () => {
    renderDrawer();

    fireEvent.click(rowFor("first queued"));
    fireEvent.click(rowFor("second queued"));

    expect(screen.getAllByLabelText("Cancel queued message").length).toBe(1);
    // The tail row is the editable one, so the reveal has moved to it.
    expect(screen.getAllByLabelText("Edit queued message").length).toBe(1);
  });

  test("a tap outside the drawer disarms the revealed row", () => {
    renderDrawer();

    fireEvent.click(rowFor("first queued"));
    expect(screen.getAllByLabelText("Cancel queued message").length).toBe(1);

    fireEvent.pointerDown(document.body);

    expect(screen.queryAllByLabelText("Cancel queued message")).toEqual([]);
    expect(
      screen.getAllByLabelText("Show queued message actions").length,
    ).toBe(2);
  });
});
