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
let assistantId = "asst-1";

mock.module("@/stores/assistant-feature-flag-store", () => ({
  useAssistantFeatureFlagStore: {
    use: { assistantDesktop: () => desktopEnabled },
  },
}));

mock.module("@/stores/resolved-assistants-store", () => ({
  useResolvedAssistantsStore: { use: { activeAssistantId: () => assistantId } },
}));

let panelUnmounts = 0;

mock.module("./desktop-panel", () => ({
  DesktopPanel: ({
    viewOnly,
    onExpand,
  }: {
    viewOnly: boolean;
    onExpand: () => void;
  }) => {
    useEffect(() => {
      return () => {
        panelUnmounts += 1;
      };
    }, []);
    return (
      <div data-testid="desktop-panel" data-view-only={viewOnly}>
        {viewOnly ? <button onClick={onExpand}>Expand desktop</button> : null}
      </div>
    );
  },
}));

const { AssistantDesktopAffordance } =
  await import("./assistant-desktop-affordance");

const { AssistantDesktopSidebar } = await import("./assistant-desktop-sidebar");
const { useDesktopSidebarStore } = await import("./desktop-sidebar-store");

function DesktopHarness() {
  return (
    <>
      <AssistantDesktopAffordance />
      <AssistantDesktopSidebar />
    </>
  );
}

const openDesktop = async () => {
  render(<DesktopHarness />);
  fireEvent.click(screen.getByRole("button", { name: "Open desktop" }));
  await waitFor(() =>
    expect(screen.getByTestId("desktop-panel")).not.toBeNull(),
  );
};

beforeEach(() => {
  localStorage.removeItem("desktop-sidebar-width");
  panelUnmounts = 0;
  desktopEnabled = true;
  assistantId = "asst-1";
  useDesktopSidebarStore.getState().close();
});

afterEach(cleanup);

describe("AssistantDesktopAffordance", () => {
  for (const flag of [false, undefined]) {
    test(`hides the desktop control and panel when the flag is ${flag}`, () => {
      desktopEnabled = flag;
      render(<DesktopHarness />);
      expect(screen.queryByRole("button", { name: "Open desktop" })).toBeNull();
      expect(screen.queryByTestId("desktop-panel")).toBeNull();
    });
  }

  test("unmounts an open desktop when the flag is disabled", async () => {
    const { rerender } = render(<DesktopHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Open desktop" }));
    await waitFor(() =>
      expect(screen.getByTestId("desktop-panel")).not.toBeNull(),
    );
    desktopEnabled = false;
    rerender(<DesktopHarness />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByTestId("desktop-panel")).toBeNull();
    expect(panelUnmounts).toBe(1);
  });

  test("Escape leaves the modal open and the panel mounted", async () => {
    await openDesktop();
    fireEvent.click(screen.getByRole("button", { name: "Expand desktop" }));

    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });

    expect(screen.getByRole("dialog")).not.toBeNull();
    expect(screen.getByTestId("desktop-panel")).not.toBeNull();
    expect(panelUnmounts).toBe(0);
  });

  test("clicks inside the expanded desktop keep it open", async () => {
    await openDesktop();
    fireEvent.click(screen.getByRole("button", { name: "Expand desktop" }));
    fireEvent.pointerDown(screen.getByTestId("desktop-panel"));
    fireEvent.click(screen.getByTestId("desktop-panel"));
    expect(screen.getByRole("dialog")).not.toBeNull();
    expect(panelUnmounts).toBe(0);
  });

  test("closing fullscreen restores the same preview session", async () => {
    await openDesktop();

    fireEvent.click(screen.getByRole("button", { name: "Expand desktop" }));
    expect(screen.getByTestId("desktop-panel").dataset.viewOnly).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(panelUnmounts).toBe(0);
    expect(screen.getByTestId("desktop-panel").dataset.viewOnly).toBe("true");
  });

  test("toggles the sidebar without opening fullscreen", async () => {
    await openDesktop();
    expect(screen.queryByRole("dialog")).toBeNull();
    const collapse = screen.getByRole("button", {
      name: "Collapse desktop sidebar",
    });
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(collapse);
    expect(screen.queryByTestId("desktop-panel")).toBeNull();
    expect(panelUnmounts).toBe(1);
    expect(screen.getByRole("button", { name: "Open desktop" })).not.toBeNull();
  });

  test("resizes the preview without reconnecting and restores its width on reopen", async () => {
    await openDesktop();
    const handle = screen.getByRole("separator", {
      name: "Resize desktop sidebar",
    });
    const panel = screen.getByRole("complementary", { name: "Desktop" });
    const originalWidth = parseFloat(panel.style.width);
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(parseFloat(panel.style.width)).toBe(originalWidth + 16);
    expect(panelUnmounts).toBe(0);

    fireEvent.click(
      screen.getByRole("button", { name: "Collapse desktop sidebar" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Open desktop" }));
    expect(
      screen.getByRole("complementary", { name: "Desktop" }).style.width,
    ).toBe(`${originalWidth + 16}px`);
  });

  test("switching assistants closes the previous session", async () => {
    const { rerender } = render(<DesktopHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Open desktop" }));
    await waitFor(() =>
      expect(screen.getByTestId("desktop-panel")).not.toBeNull(),
    );
    assistantId = "asst-2";
    rerender(<DesktopHarness />);
    expect(screen.queryByTestId("desktop-panel")).toBeNull();
    expect(panelUnmounts).toBe(1);
    assistantId = "asst-1";
    rerender(<DesktopHarness />);
    expect(screen.queryByTestId("desktop-panel")).toBeNull();
  });
});
