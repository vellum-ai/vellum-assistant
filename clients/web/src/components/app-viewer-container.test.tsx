/**
 * Tests for `AppViewerContainer`: fullscreen mode and that app actions are
 * forwarded to the sandbox fetch proxy.
 *
 * We mount via `@testing-library/react` (backed by happy-dom — see
 * `clients/web/test-setup.ts`). The bridge injection is a no-op and the
 * sandbox fetch-proxy hook is mocked to capture its options so the forwarding
 * test can assert on the `onAction` it received.
 *
 * Buttons are located by their lucide glyph class (e.g. `svg.lucide-maximize2`,
 * `svg.lucide-minimize2`) rather than by accessible name, because the
 * design-library `Button` only exposes its tooltip text via a Radix tooltip
 * while open.
 */

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

let capturedOptions:
  | { onAction?: (actionId: string, data?: Record<string, unknown>) => void }
  | undefined;
mock.module("@/hooks/use-sandbox-fetch-proxy", () => ({
  useSandboxFetchProxy: (
    _ref: unknown,
    options?: {
      onAction?: (actionId: string, data?: Record<string, unknown>) => void;
    },
  ) => {
    capturedOptions = options;
  },
}));

mock.module("@/utils/sandbox-bridge", () => ({
  injectBridge: (html: string) => html,
}));

import { AppViewerContainer } from "@/components/app-viewer-container";
import { toggleAppIframeSandboxDisabled } from "@/lib/app-sandbox-debug-flag";

spyOn(console, "warn").mockImplementation(() => {});
spyOn(console, "info").mockImplementation(() => {});

function setSandboxFlag(value: boolean): void {
  act(() => {
    toggleAppIframeSandboxDisabled(value);
  });
}

function getIframe(): HTMLIFrameElement {
  return document.querySelector("iframe") as HTMLIFrameElement;
}

afterEach(() => {
  setSandboxFlag(false);
  cleanup();
  capturedOptions = undefined;
});

function renderViewer(props?: { enableFullscreen?: boolean; appId?: string }) {
  // The viewer reads the app's Vercel deployment status through TanStack
  // Query, so it needs a client in scope even when the read is disabled (no
  // deploy handler is passed here).
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AppViewerContainer
        appId={props?.appId ?? "app-1"}
        appName="My App"
        html="<html><body>hi</body></html>"
        assistantId="assistant-1"
        onClose={() => {}}
        enableFullscreen={props?.enableFullscreen}
      />
    </QueryClientProvider>,
  );
}

function getMaximizeButton(): HTMLButtonElement | null {
  return (
    document.querySelector("svg.lucide-maximize2")?.closest("button") ?? null
  );
}

function getFloatingExitButton(): HTMLButtonElement | null {
  // The floating exit button lives inside the `absolute z-10` container (its
  // top/right offsets are applied via inline safe-area-aware styles); scope to
  // that so we don't match any nav-bar button.
  const container = document.querySelector(".absolute.z-10");
  return (
    container?.querySelector("svg.lucide-minimize2")?.closest("button") ?? null
  );
}

function getRoot(): HTMLElement {
  return document.querySelector(
    "[data-testid='app-viewer-root']",
  ) as HTMLElement;
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

describe("AppViewerContainer app actions", () => {
  test("forwards onAction to the sandbox fetch proxy", () => {
    const onAction = () => {};
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <AppViewerContainer
          appId="app-1"
          appName="My App"
          html="<html><body>hi</body></html>"
          assistantId="assistant-1"
          onClose={() => {}}
          onAction={onAction}
        />
      </QueryClientProvider>,
    );

    expect(capturedOptions?.onAction).toBe(onAction);
  });

  test("omits onAction when the consumer doesn't provide one", () => {
    renderViewer();

    expect(capturedOptions?.onAction).toBeUndefined();
  });
});

describe("AppViewerContainer sandbox debug flag", () => {
  test("sandboxes the app frame by default", () => {
    renderViewer();

    expect(getIframe().getAttribute("sandbox")).toBe(
      "allow-scripts allow-popups allow-popups-to-escape-sandbox",
    );
  });

  test("drops the sandbox and reloads the frame once the flag is set", () => {
    renderViewer();
    const sandboxed = getIframe();

    setSandboxFlag(true);

    const unsandboxed = getIframe();
    expect(unsandboxed.hasAttribute("sandbox")).toBe(false);
    // A new element, so the document reloads into the real origin instead
    // of keeping the opaque one it was created with.
    expect(unsandboxed).not.toBe(sandboxed);
  });

  test("restores the sandbox when the flag goes back to false", () => {
    renderViewer();

    setSandboxFlag(true);
    setSandboxFlag(false);

    expect(getIframe().getAttribute("sandbox")).toBe(
      "allow-scripts allow-popups allow-popups-to-escape-sandbox",
    );
  });

  test("keeps the sandbox for a non-boolean from the untyped console", () => {
    renderViewer();

    // The console has no types, so a stray string can reach the toggle.
    act(() => {
      toggleAppIframeSandboxDisabled("true" as unknown as boolean);
    });

    expect(getIframe().hasAttribute("sandbox")).toBe(true);
  });
});
