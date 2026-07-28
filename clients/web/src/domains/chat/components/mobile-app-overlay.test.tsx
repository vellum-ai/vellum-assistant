/**
 * Tests for `MobileAppOverlay` — the minimized-strip geometry contract.
 *
 * `AppViewerContainer` and the viewport-style hook are mocked; these tests
 * pin the strip transform to the hook's effective bottom inset
 * (`--overlay-safe-area-bottom`) and keep the shell's transparent safe-area
 * padding band from intercepting taps meant for the lifted composer.
 */

import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("@/components/app-viewer-container", () => ({
  AppViewerContainer: () => null,
}));
mock.module("@/hooks/use-mobile-overlay-viewport-style", () => ({
  useMobileOverlayViewportStyle: () => ({}),
}));

const { MobileAppOverlay } = await import(
  "@/domains/chat/components/mobile-app-overlay"
);

function renderOverlay(isAppMinimized: boolean): string {
  return renderToStaticMarkup(
    <MobileAppOverlay
      openedAppState={{
        appId: "app-1",
        dirName: "app-1",
        name: "Demo",
        html: "<p></p>",
      }}
      isAppMinimized={isAppMinimized}
      assistantId="assistant-1"
      onToggleMinimized={() => undefined}
      onClose={() => undefined}
      onShare={() => undefined}
      isSharing={false}
      isDeploying={false}
    />,
  );
}

describe("MobileAppOverlay", () => {
  test("minimized transform subtracts the hook's effective bottom inset", () => {
    const rendered = renderOverlay(true);

    // The hook zeroes `--overlay-safe-area-bottom` while the keyboard is
    // open; subtracting the raw physical inset instead floats the strip
    // above the keyboard by the home-indicator height.
    expect(rendered).toContain("--overlay-safe-area-bottom");
    expect(rendered).not.toContain("safe-area-inset-bottom");
  });

  test("minimized shell does not hit-test; the inner sheet re-enables it", () => {
    const rendered = renderOverlay(true);

    // The shell's transparent padding band sits over the lifted composer —
    // it must not swallow taps, while the visible strip stays interactive.
    expect(rendered).toContain("pointer-events-none");
    expect(rendered).toContain("pointer-events-auto");
  });

  test("expanded overlay keeps normal pointer events", () => {
    const rendered = renderOverlay(false);

    expect(rendered).not.toContain("pointer-events-none");
  });
});
