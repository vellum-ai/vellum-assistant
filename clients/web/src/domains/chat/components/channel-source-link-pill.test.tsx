import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

const isMobileRef = { value: false };
mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => isMobileRef.value,
}));

const { ChannelSourceLinkPill } = await import("./channel-source-link-pill");

afterEach(() => {
  isMobileRef.value = false;
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

  test("renders an icon-only anchor with an aria-label on mobile", () => {
    isMobileRef.value = true;
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
    expect(link.textContent).not.toContain("Open in Slack");
  });
});
