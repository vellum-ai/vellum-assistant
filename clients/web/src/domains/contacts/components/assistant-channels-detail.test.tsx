import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, fireEvent, render } from "@testing-library/react";

import { MemoryRouter } from "react-router";

import { AssistantChannelsDetail } from "@/domains/contacts/components/assistant-channels-detail";
import type { AssistantChannelState } from "@/types/channel-types";

const CHANNELS: AssistantChannelState[] = [
  {
    key: "slack",
    status: "ready",
    configured: true,
    canDisconnect: true,
    canManualEntry: true,
    address: "@vex",
  },
  {
    key: "telegram",
    status: "not_configured",
    configured: false,
    canDisconnect: true,
    canManualEntry: true,
  },
  {
    key: "phone",
    status: "not_configured",
    configured: false,
    canDisconnect: true,
    canManualEntry: true,
  },
];

afterEach(() => {
  cleanup();
});

describe("assistant channels detail (contact card)", () => {
  test("the Contacts detail view renders the identity header card and Channels card", () => {
    render(
      <MemoryRouter>
        <AssistantChannelsDetail assistantName="Vex" channels={CHANNELS} />
      </MemoryRouter>,
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
      <MemoryRouter>
        <AssistantChannelsDetail
          assistantName="Vex"
          channels={CHANNELS}
          onConnect={() => {}}
          onDisconnect={() => {}}
        />
      </MemoryRouter>,
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

  test("a configured channel that is not delivering keeps its address and Disconnect", () => {
    // The row reads two axes. Offering Connect here would hand the guardian a
    // fresh setup conversation for a channel that is already set up, and take
    // away the only control that could actually change anything, while the
    // outage it is reporting clears itself in about forty seconds.
    render(
      <MemoryRouter>
        <AssistantChannelsDetail
          assistantName="Vex"
          channels={[
            {
              key: "slack",
              status: "incomplete",
              configured: true,
              canDisconnect: true,
              canManualEntry: true,
              health: "failing",
              address: "@vex",
            },
          ]}
          onConnect={() => {}}
          onDisconnect={() => {}}
        />
      </MemoryRouter>,
    );

    expect(document.body.textContent).toContain("@vex");
    expect(document.body.textContent).toContain("Reconnecting");
    expect(document.body.textContent).not.toContain("Connected");
    const labels = Array.from(document.querySelectorAll("button")).map((b) =>
      b.textContent?.trim(),
    );
    expect(labels).toContain("Disconnect");
    expect(labels).not.toContain("Connect");
  });

  test("a configured channel with no delete route offers Manage, not Disconnect", () => {
    // No route means no one-click teardown exists (email; Discord below its
    // config gate). The row must still lead somewhere: a Manage link to the
    // channel's panel, and no danger button that could never be enabled.
    render(
      <MemoryRouter>
        <AssistantChannelsDetail
          assistantName="Vex"
          channels={[
            {
              key: "discord",
              status: "ready",
              configured: true,
              canDisconnect: false,
              canManualEntry: false,
              address: "@vex",
            },
          ]}
          onConnect={() => {}}
          onDisconnect={() => {}}
        />
      </MemoryRouter>,
    );

    expect(document.body.textContent).not.toContain("Disconnect");
    const manage = Array.from(document.querySelectorAll("a")).find(
      (a) => a.textContent?.trim() === "Manage",
    );
    expect(manage?.getAttribute("href")).toBe(
      "/assistant/channels?setup=discord",
    );
  });

  test("disconnecting from the contact card asks for confirmation first", () => {
    const disconnected: string[] = [];
    render(
      <MemoryRouter>
        <AssistantChannelsDetail
          assistantName="Vex"
          channels={CHANNELS}
          onDisconnect={(key) => disconnected.push(key)}
        />
      </MemoryRouter>,
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
