/**
 * Tests for `AppViewerContainer` fullscreen mode.
 *
 * We mount via `@testing-library/react` (backed by happy-dom — see
 * `apps/web/test-setup.ts`). The sandbox fetch-proxy hook and the bridge
 * injection are mocked to no-ops so the iframe renders without browser-only
 * plumbing.
 *
 * Buttons are located by their lucide glyph class (e.g. `svg.lucide-maximize2`,
 * `svg.lucide-minimize2`) rather than by accessible name, because the
 * design-library `Button` only exposes its tooltip text via a Radix tooltip
 * while open.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { act, cleanup, fireEvent, render } from "@testing-library/react";

mock.module("@/hooks/use-sandbox-fetch-proxy", () => ({
  useSandboxFetchProxy: () => {},
}));

mock.module("@/utils/sandbox-bridge", () => ({
  injectBridge: (html: string) => html,
}));

import { AppViewerContainer } from "@/components/app-viewer-container";

afterEach(() => {
  cleanup();
});

function renderViewer(props?: { enableFullscreen?: boolean; appId?: string }) {
  return render(
    <AppViewerContainer
      appId={props?.appId ?? "app-1"}
      appName="My App"
      html="<html><body>hi</body></html>"
      assistantId="assistant-1"
      onClose={() => {}}
      enableFullscreen={props?.enableFullscreen}
    />,
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
