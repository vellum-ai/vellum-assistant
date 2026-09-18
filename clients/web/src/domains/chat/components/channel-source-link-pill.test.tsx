import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

const isMobileRef = { value: false };
mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => isMobileRef.value,
}));

const isNativeRef = { value: false };
const openUrlMock = mock((_url: string) => Promise.resolve());
// Include every export other same-process test files consume — bun's
// mock.module is process-global, so an incomplete factory breaks sibling
// suites that import the unmocked names.
mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => isNativeRef.value,
  useIsNativePlatform: () => isNativeRef.value,
}));
mock.module("@/runtime/browser", () => ({
  openUrl: openUrlMock,
  openUrlInNewTab: openUrlMock,
  openExternalUrl: openUrlMock,
}));

const { ChannelSourceLinkPill } = await import("./channel-source-link-pill");

afterEach(() => {
  isMobileRef.value = false;
  isNativeRef.value = false;
  openUrlMock.mockClear();
  cleanup();
});

describe("ChannelSourceLinkPill", () => {
  test("renders a new-tab anchor with the Slack label on desktop", () => {
    const { getByRole } = render(
      <ChannelSourceLinkPill
        href="https://acme.slack.com/archives/C123/p456"
        channelId="slack"
      />,
    );

    const link = getByRole("link", { name: /open in slack/i });
    expect(link.getAttribute("href")).toBe(
      "https://acme.slack.com/archives/C123/p456",
    );
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  // A narrow header keeps its room for the controls that act on the
  // conversation. The same destination stays reachable from the conversation
  // actions sheet, which carries `channelSourceLink` as one of its items.
  test("renders nothing on mobile", () => {
    isMobileRef.value = true;
    const { container, queryByRole } = render(
      <ChannelSourceLinkPill
        href="https://acme.slack.com/archives/C123/p456"
        channelId="slack"
      />,
    );

    expect(queryByRole("link")).toBeNull();
    expect(container.innerHTML).toBe("");
  });

  test("routes clicks through the native URL opener on Capacitor", () => {
    isNativeRef.value = true;
    const { getByRole } = render(
      <ChannelSourceLinkPill
        href="https://acme.slack.com/archives/C123/p456"
        channelId="slack"
      />,
    );

    getByRole("link", { name: /open in slack/i }).click();
    expect(openUrlMock).toHaveBeenCalledWith(
      "https://acme.slack.com/archives/C123/p456",
    );
  });
});
