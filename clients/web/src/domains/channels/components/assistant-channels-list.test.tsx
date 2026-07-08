import { afterEach, describe, expect, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import {
  AssistantChannelsList,
  type AssistantChannelsListProps,
} from "@/domains/channels/components/assistant-channels-list";
import type { AssistantChannelState } from "@/types/channel-types";

const CHANNELS: AssistantChannelState[] = [
  { key: "slack", status: "ready", address: "@vex" },
  { key: "telegram", status: "not_configured" },
  { key: "phone", status: "not_configured" },
];

// The Slack panel owns its own queries (`SlackChannelSection`), so list
// renders need a QueryClient. Queries fail fast (retry off, no server) and
// the panel shows its error state, which these assertions don't depend on.
// The router wrapper is for the tier legend's settings link.
function renderList(extraProps: Partial<AssistantChannelsListProps> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <AssistantChannelsList
          assistantId="assistant-1"
          assistantName="Vex"
          channels={CHANNELS}
          {...extraProps}
        />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
});

describe("assistant channels list", () => {
  test("the bare channel list (standalone Channels tab) has no identity card", () => {
    renderList();
    expect(document.body.textContent).not.toContain("Vex (Your Assistant)");
    expect(document.body.textContent).toContain("Slack");
    expect(document.body.textContent).toContain("Telegram");
  });

  test("renders the adapter sub-tabs", () => {
    renderList();
    expect(document.querySelector('[data-slot="tabs"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Phone");
    expect(document.body.textContent).not.toContain("Phone Calling");
    // Slack (connected) is the default tab: Tag chip + disconnect affordance.
    expect(document.body.textContent).toContain("Connected");
    expect(document.body.textContent).toContain("Disconnect");
  });

  test("the Slack sub-tab consolidates connection state into a single card", () => {
    renderList({
      onDisconnect: () => {},
      channelPolicies: { slack: "trusted_contacts" },
      onChannelPolicyChange: () => {},
    });

    // Card header row: @handle + Connected chip + Disconnect; card body:
    // the Thread Behavior radios.
    expect(document.body.textContent).toContain("@vex");
    expect(document.body.textContent).toContain("Connected");
    expect(document.body.textContent).toContain("Disconnect");
    expect(document.body.textContent).toContain("Thread Behavior");

    // No trust-floor dropdown even with a policy handler wired — Slack has
    // no channel-wide floor control. And no duplicated wrapper header or
    // "Connected as" subline.
    expect(document.body.textContent).not.toContain("Who can message");
    expect(document.body.textContent).not.toContain("Slack settings");
    expect(document.body.textContent).not.toContain("Connected as");
  });

  test("the Slack Disconnect affordance is low-weight but still confirms first", () => {
    const disconnected: string[] = [];
    renderList({ onDisconnect: (key) => disconnected.push(key) });

    const disconnectButton = Array.from(
      document.querySelectorAll("button"),
    ).find((b) => b.textContent?.trim() === "Disconnect");
    expect(disconnectButton).toBeDefined();
    // Ghost weight, not the destructive filled variant.
    expect(disconnectButton!.className).not.toContain("system-negative");

    fireEvent.click(disconnectButton!);
    expect(disconnected).toEqual([]);

    const confirmButton = document.querySelector<HTMLButtonElement>(
      "[data-confirm-dialog-confirm]",
    );
    expect(confirmButton).not.toBeNull();
    fireEvent.click(confirmButton!);
    expect(disconnected).toEqual(["slack"]);
  });

  test("connected Telegram keeps the trust-floor dropdown", () => {
    renderList({
      channels: [
        { key: "telegram", status: "ready", address: "@vex_bot" },
        { key: "slack", status: "ready", address: "@vex" },
        { key: "phone", status: "not_configured" },
      ],
      channelPolicies: { telegram: "trusted_contacts" },
      onChannelPolicyChange: () => {},
    });
    expect(document.body.textContent).toContain("Who can message Vex");
  });

  test("disconnected tab swaps the empty state for the manual form on request", () => {
    renderList();

    const telegramTab = Array.from(
      document.querySelectorAll('[data-slot="tabs-trigger"]'),
    ).find((t) => t.textContent === "Telegram");
    expect(telegramTab).toBeDefined();
    // Radix tab triggers select on mousedown (automatic activation), not click.
    fireEvent.mouseDown(telegramTab!, { button: 0 });

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

  test("a setup deep link opens the manual form directly", () => {
    // The mobile chat-drawer handoff navigates to `?setup=<channel>` to
    // continue credential entry here — it must land on the form, not the
    // empty state whose Set up button would start another conversation.
    renderList({ initialChannel: "telegram" });
    expect(document.body.textContent).toContain("Bot Token");
    expect(document.body.textContent).not.toContain("Telegram isn't connected");
  });
});
