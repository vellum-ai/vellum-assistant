import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useEffect, useState } from "react";

import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

let desktopEnabled: boolean | undefined = true;
let assistantId = "asst-1";
let touch = false;
let platformHosted = true;
let automationActive: boolean | undefined = false;
mock.module("./use-desktop-setup", () => ({
  useDesktopSetupStatus: () => ({ query: { data: { automationActive } } }),
}));

mock.module("@/hooks/use-platform-gate", () => ({
  useActiveAssistantIsPlatformHosted: () => platformHosted,
}));

mock.module("@/utils/pointer", () => ({
  usePointerCoarse: () => touch,
  isPointerCoarse: () => touch,
}));

mock.module("@/stores/assistant-feature-flag-store", () => ({
  useAssistantFeatureFlagStore: {
    use: { assistantDesktop: () => desktopEnabled },
  },
}));

mock.module("@/stores/resolved-assistants-store", () => ({
  useResolvedAssistantsStore: {
    use: {
      activeAssistantId: () => assistantId,
      assistants: () => [
        { id: "asst-1", name: "Alice" },
        { id: "asst-2", name: "Bob" },
      ],
    },
  },
}));

let panelUnmounts = 0;

mock.module("./desktop-panel", () => ({
  DesktopPanel: ({ viewOnly }: { viewOnly: boolean }) => {
    useEffect(() => {
      return () => {
        panelUnmounts += 1;
      };
    }, []);
    return <div data-testid="desktop-panel" data-view-only={viewOnly}></div>;
  },
}));

const { AssistantDesktopAffordance } =
  await import("./assistant-desktop-affordance");

const { AssistantDesktopPreview } = await import("./assistant-desktop-preview");
const { useDesktopPreviewStore } = await import("./desktop-preview-store");

function DesktopHarness() {
  return (
    <>
      <AssistantDesktopAffordance />
      <AssistantDesktopPreview />
    </>
  );
}

const openDesktop = async () => {
  render(<DesktopHarness />);
  fireEvent.click(
    screen.getByRole("button", { name: "Open Alice's virtual desktop" }),
  );
  await waitFor(() =>
    expect(screen.getByTestId("desktop-panel")).not.toBeNull(),
  );
};

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
  touch = false;
  platformHosted = true;
  automationActive = false;
  useDesktopPreviewStore.setState({ position: null });
  panelUnmounts = 0;
  desktopEnabled = true;
  assistantId = "asst-1";
  useDesktopPreviewStore.getState().close();
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

describe("AssistantDesktopAffordance", () => {
  test("updates the name after a rename and ignores another assistant's identity", () => {
    const { rerender } = render(<DesktopHarness />);
    act(() => {
      useAssistantIdentityStore
        .getState()
        .setIdentity("Example Assistant", null, "asst-1");
    });
    expect(
      screen.getByRole("button", {
        name: "Open Example Assistant's virtual desktop",
      }),
    ).not.toBeNull();
    assistantId = "asst-2";
    rerender(<DesktopHarness />);
    expect(
      screen.getByRole("button", { name: "Open Bob's virtual desktop" }),
    ).not.toBeNull();
  });

  test("opening from navigation dismisses the menu and keeps fullscreen open", async () => {
    touch = true;
    function MenuHarness() {
      const [menuOpen, setMenuOpen] = useState(true);
      return (
        <>
          {menuOpen && (
            <nav aria-label="Navigation">
              <AssistantDesktopAffordance onToggle={() => setMenuOpen(false)} />
            </nav>
          )}
          <AssistantDesktopPreview />
        </>
      );
    }
    render(<MenuHarness />);
    fireEvent.click(
      screen.getByRole("button", { name: "Open Alice's virtual desktop" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("desktop-panel")).toBeTruthy(),
    );
    expect(screen.queryByRole("navigation") === null).toBe(true);
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    await waitFor(() =>
      expect(screen.queryByTestId("desktop-panel") === null).toBe(true),
    );
  });

  test("touch opens directly in fullscreen and closing dismisses the desktop", async () => {
    touch = true;
    await openDesktop();
    expect(screen.getByRole("dialog")).not.toBeNull();
    expect(screen.getByTestId("desktop-panel").dataset.viewOnly).toBe("false");
    expect(
      screen.queryByRole("button", { name: "Expand virtual desktop" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    await waitFor(() =>
      expect(screen.queryByTestId("desktop-panel") === null).toBe(true),
    );
    expect(
      screen.getByRole("button", { name: "Open Alice's virtual desktop" }),
    ).not.toBeNull();
  });
  for (const flag of [false, undefined]) {
    test(`hides the desktop control and panel when the flag is ${flag}`, () => {
      desktopEnabled = flag;
      render(<DesktopHarness />);
      expect(
        screen.queryByRole("button", { name: "Open Alice's virtual desktop" }),
      ).toBeNull();
      expect(screen.queryByTestId("desktop-panel") === null).toBe(true);
    });
  }

  test("unmounts an open desktop when the flag is disabled", async () => {
    const { rerender } = render(<DesktopHarness />);
    fireEvent.click(
      screen.getByRole("button", { name: "Open Alice's virtual desktop" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("desktop-panel")).not.toBeNull(),
    );
    desktopEnabled = false;
    rerender(<DesktopHarness />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByTestId("desktop-panel") === null).toBe(true);
    expect(panelUnmounts).toBe(1);
  });

  test("Escape leaves the modal open and the panel mounted", async () => {
    await openDesktop();
    fireEvent.click(
      screen.getByRole("button", { name: "Expand virtual desktop" }),
    );

    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });

    expect(screen.getByRole("dialog")).not.toBeNull();
    expect(screen.getByTestId("desktop-panel")).not.toBeNull();
    expect(panelUnmounts).toBe(0);
  });

  test("clicks inside the expanded desktop keep it open", async () => {
    await openDesktop();
    fireEvent.click(
      screen.getByRole("button", { name: "Expand virtual desktop" }),
    );
    fireEvent.pointerDown(screen.getByTestId("desktop-panel"));
    fireEvent.click(screen.getByTestId("desktop-panel"));
    expect(screen.getByRole("dialog")).not.toBeNull();
    expect(panelUnmounts).toBe(0);
  });

  test("closing fullscreen restores the same preview session", async () => {
    await openDesktop();
    expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Expand virtual desktop" }),
    );
    expect(screen.getByTestId("desktop-panel").dataset.viewOnly).toBe("false");
    expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(panelUnmounts).toBe(0);
    expect(screen.getByTestId("desktop-panel").dataset.viewOnly).toBe("true");
    expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
  });

  test("toggles the floating preview without opening fullscreen", async () => {
    await openDesktop();
    expect(screen.queryByRole("dialog")).toBeNull();
    const collapse = screen.getByRole("button", {
      name: "Hide virtual desktop",
    });
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(collapse);
    expect(panelUnmounts).toBe(0);
    await waitFor(() =>
      expect(screen.queryByTestId("desktop-panel") === null).toBe(true),
    );
    expect(panelUnmounts).toBe(1);
    expect(
      screen.getByRole("button", { name: "Open Alice's virtual desktop" }),
    ).not.toBeNull();
  });

  test("the preview X closes it without opening fullscreen", async () => {
    await openDesktop();
    fireEvent.click(
      screen.getByRole("button", { name: "Close virtual desktop preview" }),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("desktop-panel") === null).toBe(true),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Open Alice's virtual desktop" }),
    ).not.toBeNull();
  });

  function mockPreviewGeometry() {
    const frame = document.getElementById("assistant-desktop-preview")!;
    Object.defineProperties(frame, {
      offsetWidth: { configurable: true, value: 320 },
      offsetHeight: { configurable: true, value: 220 },
      offsetLeft: {
        configurable: true,
        get: () => Number.parseFloat(frame.style.left || "480"),
      },
      offsetTop: {
        configurable: true,
        get: () => Number.parseFloat(frame.style.top || "380"),
      },
      setPointerCapture: { configurable: true, value: () => {} },
    });
    Object.defineProperties(frame.parentElement!, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 600 },
    });
    return frame;
  }

  test("dragging moves the preview without expanding and the X still closes it", async () => {
    await openDesktop();
    const frame = mockPreviewGeometry();
    const expand = screen.getByRole("button", {
      name: "Expand virtual desktop",
    });
    const pointer = { pointerId: 1, button: 0, buttons: 1, isPrimary: true };
    fireEvent.pointerDown(expand, { ...pointer, clientX: 500, clientY: 400 });
    fireEvent.pointerMove(frame, { ...pointer, clientX: 300, clientY: 200 });
    fireEvent.pointerUp(frame, pointer);
    fireEvent.click(expand, { detail: 1 });
    expect(useDesktopPreviewStore.getState().position).toEqual({
      x: 280,
      y: 180,
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(panelUnmounts).toBe(0);

    const close = screen.getByRole("button", {
      name: "Close virtual desktop preview",
    });
    fireEvent.pointerDown(close, pointer);
    fireEvent.click(close, { detail: 1 });
    expect(useDesktopPreviewStore.getState().session).toBeNull();
  });

  test("keyboard movement keeps the preview inside the available area", async () => {
    await openDesktop();
    const frame = mockPreviewGeometry();
    const move = screen.getByRole("button", {
      name: "Move virtual desktop preview (arrow keys)",
    });
    fireEvent.keyDown(move, { key: "ArrowLeft" });
    expect(frame.style.left).toBe("464px");
    fireEvent.keyDown(move, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(move, { key: "ArrowDown" });
    expect(useDesktopPreviewStore.getState().position).toEqual({
      x: 480,
      y: 380,
    });
    expect(panelUnmounts).toBe(0);
  });

  test("switching assistants closes the previous session", async () => {
    const { rerender } = render(<DesktopHarness />);
    fireEvent.click(
      screen.getByRole("button", { name: "Open Alice's virtual desktop" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("desktop-panel")).not.toBeNull(),
    );
    assistantId = "asst-2";
    rerender(<DesktopHarness />);
    expect(screen.queryByTestId("desktop-panel") === null).toBe(true);
    expect(panelUnmounts).toBe(1);
    assistantId = "asst-1";
    rerender(<DesktopHarness />);
    expect(screen.queryByTestId("desktop-panel") === null).toBe(true);
  });
});

test("self-hosted assistants cannot open the virtual desktop even with its flag enabled", () => {
  platformHosted = false;
  render(<DesktopHarness />);
  expect(
    screen.queryByRole("button", { name: "Open Alice's virtual desktop" }),
  ).toBeNull();
  expect(screen.queryByTestId("desktop-panel")).toBeNull();
});

test("switching to a self-hosted assistant closes the virtual desktop preview", async () => {
  const { rerender } = render(<DesktopHarness />);
  fireEvent.click(
    screen.getByRole("button", { name: "Open Alice's virtual desktop" }),
  );
  await waitFor(() => expect(screen.getByTestId("desktop-panel")).toBeTruthy());
  platformHosted = false;
  rerender(<DesktopHarness />);
  await waitFor(() => expect(screen.queryByTestId("desktop-panel")).toBeNull());
  expect(useDesktopPreviewStore.getState().session).toBeNull();
});

test("desktop icon pulses during automation and clears when it ends", () => {
  const { rerender } = render(<DesktopHarness />);
  const icon = () =>
    screen
      .getByRole("button", { name: "Open Alice's virtual desktop" })
      .querySelector("svg")!;
  expect(icon().classList.contains("motion-safe:animate-pulse")).toBe(false);
  automationActive = true;
  rerender(<DesktopHarness />);
  expect(icon().classList.contains("motion-safe:animate-pulse")).toBe(true);
  expect(icon().getAttribute("stroke")).toBe(
    "var(--avatar-accent, var(--content-emphasised))",
  );
  automationActive = undefined;
  rerender(<DesktopHarness />);
  expect(icon().getAttribute("stroke")).toBe("currentColor");
  expect(icon().classList.contains("motion-safe:animate-pulse")).toBe(false);
});
