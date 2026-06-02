/**
 * Verifies the mobile open-app overlay forwards live-build state
 * (`compileStatus`/`buildErrors`) to `AppViewerContainer`, so the mobile path
 * surfaces the same non-blocking build-error badge as desktop.
 *
 * `AppViewerContainer` pulls in a heavy subtree (sandbox proxy, matchMedia via
 * `useIsMobile`) that doesn't server-render, so we stub it and assert on the
 * props the overlay hands down.
 */

import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { AppViewerContainerProps } from "@/components/app-viewer-container";

const captured: { props?: AppViewerContainerProps } = {};
const lastProps = (): AppViewerContainerProps | undefined => captured.props;
mock.module("@/components/app-viewer-container", () => ({
  AppViewerContainer: (props: AppViewerContainerProps) => {
    captured.props = props;
    return null;
  },
}));

// Imported AFTER the mock so the component picks up the stub.
import { MobileAppOverlay } from "@/domains/chat/components/mobile-app-overlay";
import type { OpenedAppState } from "@/stores/viewer-store";

const baseAppState: OpenedAppState = {
  appId: "app-1",
  name: "My App",
  html: "<html></html>",
};

const noopProps = {
  isAppMinimized: false,
  assistantId: "assistant-1",
  onToggleMinimized: () => {},
  onClose: () => {},
  onShare: () => {},
  isSharing: false,
  isDeploying: false,
};

describe("MobileAppOverlay", () => {
  test("forwards compileStatus and buildErrors to AppViewerContainer", () => {
    captured.props = undefined;
    renderToStaticMarkup(
      <MobileAppOverlay
        {...noopProps}
        openedAppState={{
          ...baseAppState,
          compileStatus: "error",
          buildErrors: ["TS2322: type error"],
        }}
      />,
    );
    expect(lastProps()?.compileStatus).toBe("error");
    expect(lastProps()?.buildErrors).toEqual(["TS2322: type error"]);
  });

  test("forwards undefined build state when none is present", () => {
    captured.props = undefined;
    renderToStaticMarkup(
      <MobileAppOverlay {...noopProps} openedAppState={baseAppState} />,
    );
    expect(lastProps()?.compileStatus).toBeUndefined();
    expect(lastProps()?.buildErrors).toBeUndefined();
  });
});
