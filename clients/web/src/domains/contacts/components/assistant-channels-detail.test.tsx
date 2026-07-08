import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, fireEvent, render } from "@testing-library/react";

import { AssistantChannelsDetail } from "@/domains/contacts/components/assistant-channels-detail";
import type { AssistantChannelState } from "@/domains/contacts/types";

const CHANNELS: AssistantChannelState[] = [
  { key: "slack", status: "ready", address: "@vex" },
  { key: "telegram", status: "not_configured" },
  { key: "phone", status: "not_configured" },
];

afterEach(() => {
  cleanup();
});

describe("assistant channels detail (contact card)", () => {
  test("the Contacts detail view renders the identity header card and Channels card", () => {
    render(
      <AssistantChannelsDetail assistantName="Vex" channels={CHANNELS} />,
    );
    expect(document.body.textContent).toContain("Vex (Your Assistant)");
    expect(document.body.textContent).toContain("Channels");
    expect(document.body.textContent).toContain("Slack");
  });

  test("the Contacts detail view is a plain connect/disconnect list, not the Channels-tab panel", () => {
    // The contact card renders one row per adapter — never the sub-tabs,
    // trust-floor dropdown, Slack cards, or channel list (those live in the
    // Channels tab).
    render(
      <AssistantChannelsDetail
        assistantName="Vex"
        channels={CHANNELS}
        onConnect={() => {}}
        onDisconnect={() => {}}
      />,
    );
    expect(document.querySelector('[data-slot="tabs"]')).toBeNull();
    expect(document.body.textContent).not.toContain("Who can message");
    expect(document.body.textContent).not.toContain("Thread Behavior");
    expect(document.body.textContent).not.toContain("Share Connection Link");

    // Connected Slack: handle + chip + disconnect.
    expect(document.body.textContent).toContain("@vex");
    expect(document.body.textContent).toContain("Connected");
    expect(document.body.textContent).toContain("Disconnect");

    // Disconnected Telegram/Phone: a Connect affordance, no credential forms.
    const connectButtons = Array.from(
      document.querySelectorAll("button"),
    ).filter((b) => b.textContent?.trim() === "Connect");
    expect(connectButtons).toHaveLength(2);
    expect(document.body.textContent).not.toContain("Bot Token");
  });

  test("disconnecting from the contact card asks for confirmation first", () => {
    const disconnected: string[] = [];
    render(
      <AssistantChannelsDetail
        assistantName="Vex"
        channels={CHANNELS}
        onDisconnect={(key) => disconnected.push(key)}
      />,
    );

    const disconnectButton = Array.from(
      document.querySelectorAll("button"),
    ).find((b) => b.textContent?.trim() === "Disconnect");
    expect(disconnectButton).toBeDefined();
    fireEvent.click(disconnectButton!);
    expect(disconnected).toEqual([]);

    const confirmButton = document.querySelector<HTMLButtonElement>(
      "[data-confirm-dialog-confirm]",
    );
    expect(confirmButton).not.toBeNull();
    fireEvent.click(confirmButton!);
    expect(disconnected).toEqual(["slack"]);
  });
});
