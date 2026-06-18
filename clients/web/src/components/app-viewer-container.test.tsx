/**
 * Tests for `AppViewerContainer` fullscreen mode and the `relay_prompt`
 * action relay.
 *
 * We mount via `@testing-library/react` (backed by happy-dom — see
 * `clients/web/test-setup.ts`). The bridge injection is mocked to a no-op, and
 * the sandbox fetch-proxy hook is mocked to capture the `onAction` callback so
 * the action-relay tests can invoke it directly without postMessage plumbing.
 *
 * Buttons are located by their lucide glyph class (e.g. `svg.lucide-maximize2`,
 * `svg.lucide-minimize2`) rather than by accessible name, because the
 * design-library `Button` only exposes its tooltip text via a Radix tooltip
 * while open.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import type { ReactElement } from "react";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";

// Capture the `onAction` handler the component wires into the fetch proxy so
// the relay_prompt tests can drive it directly.
let capturedOnAction:
  | ((actionId: string, data?: Record<string, unknown>) => void)
  | undefined;
mock.module("@/hooks/use-sandbox-fetch-proxy", () => ({
  useSandboxFetchProxy: (
    _ref: unknown,
    opts?: {
      onAction?: (actionId: string, data?: Record<string, unknown>) => void;
    },
  ) => {
    capturedOnAction = opts?.onAction;
  },
}));

mock.module("@/utils/sandbox-bridge", () => ({
  injectBridge: (html: string) => html,
}));

import { AppViewerContainer } from "@/components/app-viewer-container";
import { useConversationStore } from "@/stores/conversation-store";
import { useViewerStore } from "@/stores/viewer-store";
import { routes } from "@/utils/routes";

const SAMPLE_APP = {
  appId: "app-1",
  name: "My App",
  html: "<html><body>hi</body></html>",
};

afterEach(() => {
  cleanup();
  capturedOnAction = undefined;
  useViewerStore.getState().reset();
  useConversationStore.setState({ activeConversationId: null });
});

function renderViewer(props?: { enableFullscreen?: boolean; appId?: string }) {
  return render(
    <MemoryRouter>
      <AppViewerContainer
        appId={props?.appId ?? "app-1"}
        appName="My App"
        html="<html><body>hi</body></html>"
        assistantId="assistant-1"
        onClose={() => {}}
        enableFullscreen={props?.enableFullscreen}
      />
    </MemoryRouter>,
  );
}

function getMaximizeButton(): HTMLButtonElement | null {
  return document.querySelector("svg.lucide-maximize2")?.closest("button") ?? null;
}

function getFloatingExitButton(): HTMLButtonElement | null {
  // The floating exit button lives inside the `absolute z-10` container (its
  // top/right offsets are applied via inline safe-area-aware styles); scope to
  // that so we don't match any nav-bar button.
  const container = document.querySelector(".absolute.z-10");
  return container?.querySelector("svg.lucide-minimize2")?.closest("button") ?? null;
}

function getRoot(): HTMLElement {
  return document.querySelector("[data-testid='app-viewer-root']") as HTMLElement;
}

describe("AppViewerContainer fullscreen", () => {
  test("toggles into fullscreen, hiding the nav bar and showing a floating exit", () => {
    renderViewer({ enableFullscreen: true });

    const maximize = getMaximizeButton();
    expect(maximize).not.toBeNull();
    expect(getRoot().classList.contains("rounded-xl")).toBe(true);
    expect(getFloatingExitButton()).toBeNull();

    fireEvent.click(maximize as HTMLButtonElement);

    const root = getRoot();
    expect(root.classList.contains("fixed")).toBe(true);
    expect(root.classList.contains("inset-0")).toBe(true);
    expect(getMaximizeButton()).toBeNull();
    expect(getFloatingExitButton()).not.toBeNull();
  });

  test("the floating exit button restores the framed nav-bar view", () => {
    renderViewer({ enableFullscreen: true });

    fireEvent.click(getMaximizeButton() as HTMLButtonElement);
    expect(getMaximizeButton()).toBeNull();

    fireEvent.click(getFloatingExitButton() as HTMLButtonElement);

    expect(getMaximizeButton()).not.toBeNull();
    expect(getRoot().classList.contains("rounded-xl")).toBe(true);
    expect(getRoot().classList.contains("fixed")).toBe(false);
  });

  test("Escape exits fullscreen", () => {
    renderViewer({ enableFullscreen: true });

    fireEvent.click(getMaximizeButton() as HTMLButtonElement);
    expect(getRoot().classList.contains("fixed")).toBe(true);

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });

    expect(getRoot().classList.contains("fixed")).toBe(false);
    expect(getMaximizeButton()).not.toBeNull();
  });

  test("without enableFullscreen there is no fullscreen button and the root stays framed", () => {
    renderViewer();

    expect(getMaximizeButton()).toBeNull();
    expect(getRoot().classList.contains("rounded-xl")).toBe(true);
    expect(getRoot().classList.contains("fixed")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// relay_prompt action relay
// ---------------------------------------------------------------------------

// Renders the router's current location into the DOM so tests can assert
// navigation via `screen` without reaching into router internals.
function LocationProbe(): ReactElement {
  const location = useLocation();
  return (
    <>
      <span data-testid="pathname">{location.pathname}</span>
      <span data-testid="search">{location.search}</span>
    </>
  );
}
function currentPath(): string | null {
  return screen.getByTestId("pathname").textContent;
}
function currentSearch(): string | null {
  return screen.getByTestId("search").textContent;
}

function renderViewerForAction() {
  render(
    <MemoryRouter initialEntries={["/"]}>
      <AppViewerContainer
        appId="app-1"
        appName="My App"
        html="<html><body>hi</body></html>"
        assistantId="assistant-1"
        onClose={() => {}}
      />
      <LocationProbe />
    </MemoryRouter>,
  );
}

function relay(data: Record<string, unknown>) {
  act(() => {
    capturedOnAction?.("relay_prompt", data);
  });
}

describe("AppViewerContainer relay_prompt action", () => {
  test("wires an onAction handler into the fetch proxy", () => {
    renderViewerForAction();
    expect(typeof capturedOnAction).toBe("function");
  });

  test("default (no view) relays the prompt and reveals the side-by-side split", () => {
    useConversationStore.setState({ activeConversationId: "conv-1" });
    useViewerStore.setState({ mainView: "app", openedAppState: SAMPLE_APP });
    renderViewerForAction();

    relay({ prompt: "hello there" });

    expect(useViewerStore.getState().mainView).toBe("app-split");
    expect(currentPath()).toBe(routes.conversation("conv-1"));
    expect(currentSearch()).toContain("prompt=hello%20there");
  });

  test("view:'app' relays silently, leaving the app full-width", () => {
    useConversationStore.setState({ activeConversationId: "conv-1" });
    useViewerStore.setState({ mainView: "app", openedAppState: SAMPLE_APP });
    renderViewerForAction();

    relay({ prompt: "ping", view: "app" });

    expect(useViewerStore.getState().mainView).toBe("app");
    expect(currentPath()).toBe(routes.conversation("conv-1"));
    expect(currentSearch()).toContain("prompt=ping");
  });

  test("view:'chat' closes the app and reveals the conversation", () => {
    useConversationStore.setState({ activeConversationId: "conv-1" });
    useViewerStore.setState({ mainView: "app", openedAppState: SAMPLE_APP });
    renderViewerForAction();

    relay({ prompt: "switch", view: "chat" });

    const viewer = useViewerStore.getState();
    expect(viewer.mainView).toBe("chat");
    expect(viewer.openedAppState).toBeNull();
    expect(currentPath()).toBe(routes.conversation("conv-1"));
  });

  test("drops silently when there is no active conversation", () => {
    useConversationStore.setState({ activeConversationId: null });
    useViewerStore.setState({ mainView: "app", openedAppState: SAMPLE_APP });
    renderViewerForAction();

    relay({ prompt: "nowhere" });

    // No navigation away from the initial entry, view unchanged.
    expect(useViewerStore.getState().mainView).toBe("app");
    expect(currentPath()).toBe("/");
  });

  test("ignores actions other than relay_prompt and prompts without text", () => {
    useConversationStore.setState({ activeConversationId: "conv-1" });
    useViewerStore.setState({ mainView: "app", openedAppState: SAMPLE_APP });
    renderViewerForAction();

    relay({ prompt: "" });
    act(() => capturedOnAction?.("something_else", { prompt: "x" }));

    expect(useViewerStore.getState().mainView).toBe("app");
    expect(currentPath()).toBe("/");
  });
});
