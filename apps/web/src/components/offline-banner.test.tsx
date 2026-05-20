import { describe, expect, mock, test, beforeEach } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

let isNativePlatformMock = false;
let connectedMock = true;

mock.module("@/runtime/native-auth.js", () => ({
  isNativePlatform: () => isNativePlatformMock,
  useIsNativePlatform: () => isNativePlatformMock,
}));

mock.module("@/hooks/use-network-status.js", () => ({
  useNetworkStatus: () => connectedMock,
}));

mock.module("../../packages/design-library/src/components/notice.tsx", () => ({
  Notice: (props: { title: string }) => (
    <div data-testid="notice">{props.title}</div>
  ),
}));

import { OfflineBanner } from "@/components/offline-banner.js";

beforeEach(() => {
  isNativePlatformMock = false;
  connectedMock = true;
});

describe("OfflineBanner", () => {
  test("renders nothing on web (non-native)", () => {
    isNativePlatformMock = false;
    connectedMock = false;
    const html = renderToStaticMarkup(<OfflineBanner />);
    expect(html).toBe("");
  });

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
