import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, fireEvent, render } from "@testing-library/react";

import { AssistantChannelsDetail } from "@/domains/contacts/components/assistant-channels-detail";
import { AssistantChannelsList } from "@/domains/contacts/components/assistant-channels-list";
import type { AssistantChannelState } from "@/domains/contacts/types";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";

const CHANNELS: AssistantChannelState[] = [
  { key: "slack", status: "ready", address: "@vex" },
  { key: "telegram", status: "not_configured" },
  { key: "phone", status: "not_configured" },
];

function setTabbedLayout(enabled: boolean) {
  useAssistantFeatureFlagStore.setState({ channelTrustFloors: enabled });
}

afterEach(() => {
  cleanup();
  setTabbedLayout(false);
});

describe("assistant channels surfaces", () => {
  test("the Contacts detail view renders the identity header card and Channels card", () => {
    render(
      <AssistantChannelsDetail assistantName="Vex" channels={CHANNELS} />,
    );
    expect(document.body.textContent).toContain("Vex (Your Assistant)");
    expect(document.body.textContent).toContain("Channels");
    expect(document.body.textContent).toContain("Slack");
  });

  test("the bare channel list (standalone Channels tab) has no identity card", () => {
    render(<AssistantChannelsList assistantName="Vex" channels={CHANNELS} />);
    expect(document.body.textContent).not.toContain("Vex (Your Assistant)");
    expect(document.body.textContent).toContain("Slack");
    expect(document.body.textContent).toContain("Telegram");
  });

  test("channel-trust-floors off renders the accordion rows", () => {
    setTabbedLayout(false);
    render(<AssistantChannelsList assistantName="Vex" channels={CHANNELS} />);
    expect(document.body.textContent).toContain("Phone Calling");
    // Accordion rows surface per-channel Set up buttons inline.
    expect(document.body.textContent).toContain("Set up");
    expect(document.querySelector('[data-slot="tabs"]')).toBeNull();
  });

  test("channel-trust-floors on renders the adapter sub-tabs", () => {
    setTabbedLayout(true);
    render(<AssistantChannelsList assistantName="Vex" channels={CHANNELS} />);
    expect(document.querySelector('[data-slot="tabs"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Phone");
    expect(document.body.textContent).not.toContain("Phone Calling");
    // Slack (connected) is the default tab: Tag chip + disconnect affordance.
    expect(document.body.textContent).toContain("Connected");
    expect(document.body.textContent).toContain("Disconnect");
  });

  test("disconnected tab swaps the empty state for the manual form on request", () => {
    setTabbedLayout(true);
    render(
      <AssistantChannelsList
        assistantName="Vex"
        channels={CHANNELS}
        initialChannel="telegram"
      />,
    );
    expect(document.body.textContent).toContain("Telegram isn't connected");
    expect(document.body.textContent).not.toContain("Bot Token");

    const manualButton = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("or connect manually"),
    );
    expect(manualButton).toBeDefined();
    fireEvent.click(manualButton!);

    expect(document.body.textContent).toContain("Bot Token");
    expect(document.body.textContent).not.toContain("Telegram isn't connected");
  });
});
