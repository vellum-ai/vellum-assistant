import { beforeEach, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

let isNativePlatformMock = false;
let connectedMock = true;
let connectivityStateMock: "online" | "device-offline" | "backend-unreachable" =
  "online";
let isElectronMock = false;

mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => isNativePlatformMock,
  useIsNativePlatform: () => isNativePlatformMock,
}));

mock.module("@/hooks/use-network-status", () => ({
  useNetworkStatus: () => connectedMock,
}));

mock.module("@/hooks/use-connectivity-state", () => ({
  useConnectivityState: () => connectivityStateMock,
}));

mock.module("@/runtime/is-electron", () => ({
  isElectron: () => isElectronMock,
}));

mock.module("@/runtime/connectivity", () => ({
  retryConnectivity: () => {},
}));

mock.module("@vellumai/design-library/components/notice", () => ({
  Notice: (props: { title: string; actions?: React.ReactNode }) => (
    <div data-testid="notice">
      {props.title}
      {props.actions}
    </div>
  ),
}));

mock.module("@vellumai/design-library/components/button", () => ({
  Button: (props: { children: string }) => (
    <button data-testid="button">{props.children}</button>
  ),
}));

import { OfflineBanner } from "@/components/offline-banner";

beforeEach(() => {
  isNativePlatformMock = false;
  connectedMock = true;
  connectivityStateMock = "online";
  isElectronMock = false;
});

describe("OfflineBanner", () => {
  test("renders nothing on web (non-native, non-electron)", () => {
    const html = renderToStaticMarkup(<OfflineBanner />);
    expect(html).toBe("");
  });

  describe("Capacitor iOS", () => {
    test("renders nothing when connected on native", () => {
      isNativePlatformMock = true;
      connectedMock = true;
      const html = renderToStaticMarkup(<OfflineBanner />);
      expect(html).toBe("");
    });

    test("renders banner when offline on native", () => {
      isNativePlatformMock = true;
      connectedMock = false;
      const html = renderToStaticMarkup(<OfflineBanner />);
      expect(html).toContain("offline");
    });
  });

  describe("Electron", () => {
    test("renders nothing when online", () => {
      isElectronMock = true;
      connectivityStateMock = "online";
      const html = renderToStaticMarkup(<OfflineBanner />);
      expect(html).toBe("");
    });

    test("renders device-offline banner", () => {
      isElectronMock = true;
      connectivityStateMock = "device-offline";
      const html = renderToStaticMarkup(<OfflineBanner />);
      expect(html).toContain("offline");
    });

    test("renders backend-unreachable banner with retry button", () => {
      isElectronMock = true;
      connectivityStateMock = "backend-unreachable";
      const html = renderToStaticMarkup(<OfflineBanner />);
      expect(html).toContain("Trying to reach Vellum");
      expect(html).toContain("Retry now");
    });
  });
});
