/**
 * The modal around the desktop panel: Escape has to reach the pod, since
 * closing the modal unmounts the panel and gives up the viewer slot.
 *
 * The stores are mocked to a flagged-on assistant, and the panel to a marker
 * that records its own unmount, which is what ends the session.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useEffect } from "react";

let desktopEnabled: boolean | undefined = true;

mock.module("@/stores/assistant-feature-flag-store", () => ({
  useAssistantFeatureFlagStore: {
    use: { assistantDesktop: () => desktopEnabled },
  },
}));

mock.module("@/stores/resolved-assistants-store", () => ({
  useResolvedAssistantsStore: { use: { activeAssistantId: () => "asst-1" } },
}));

let panelUnmounts = 0;

mock.module("./desktop-panel", () => ({
  DesktopPanel: () => {
    useEffect(() => {
      return () => {
        panelUnmounts += 1;
      };
    }, []);
    return <div data-testid="desktop-panel" />;
  },
}));

const { AssistantDesktopAffordance } =
  await import("./assistant-desktop-affordance");

const openDesktop = async () => {
  render(<AssistantDesktopAffordance />);
  fireEvent.click(screen.getByRole("button", { name: "Open desktop" }));
  await waitFor(() =>
    expect(screen.getByTestId("desktop-panel")).not.toBeNull(),
  );
};

beforeEach(() => {
  panelUnmounts = 0;
  desktopEnabled = true;
});

afterEach(cleanup);

describe("AssistantDesktopAffordance", () => {
  for (const flag of [false, undefined]) {
    test(`hides the desktop control and panel when the flag is ${flag}`, () => {
      desktopEnabled = flag;
      render(<AssistantDesktopAffordance />);
      expect(screen.queryByRole("button", { name: "Open desktop" })).toBeNull();
      expect(screen.queryByTestId("desktop-panel")).toBeNull();
    });
  }

  test("unmounts an open desktop when the flag is disabled", async () => {
    const { rerender } = render(<AssistantDesktopAffordance />);
    fireEvent.click(screen.getByRole("button", { name: "Open desktop" }));
    await waitFor(() =>
      expect(screen.getByTestId("desktop-panel")).not.toBeNull(),
    );
    desktopEnabled = false;
    rerender(<AssistantDesktopAffordance />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByTestId("desktop-panel")).toBeNull();
    expect(panelUnmounts).toBe(1);
  });

  test("Escape leaves the modal open and the panel mounted", async () => {
    await openDesktop();

    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });

    expect(screen.getByRole("dialog")).not.toBeNull();
    expect(screen.getByTestId("desktop-panel")).not.toBeNull();
    expect(panelUnmounts).toBe(0);
  });

  test("the close button still dismisses the modal", async () => {
    await openDesktop();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(panelUnmounts).toBe(1);
  });
});
