import { afterEach, describe, expect, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";

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
// The router mounts at a channel URL because that is where the selection
// lives; the route pattern has to match the app's so `useParams` resolves.
/** Renders the current path so a navigation is assertable. */
function LocationProbe() {
  const location = useLocation();
  return <span data-testid="path">{location.pathname}</span>;
}

function renderList(
  extraProps: Partial<AssistantChannelsListProps> = {},
  channelId = "slack",
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <MemoryRouter initialEntries={[`/assistant/channels/${channelId}`]}>
      <QueryClientProvider client={queryClient}>
        <Routes>
          <Route
            path="/assistant/channels/:channelId"
            element={
              <>
                <AssistantChannelsList
                  assistantId="assistant-1"
                  assistantName="Vex"
                  channels={CHANNELS}
                  {...extraProps}
                />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

/** The left-rail adapter row whose label matches — the master-detail selector. */
function adapterRow(label: string): HTMLElement {
  const row = Array.from(
    document.querySelectorAll<HTMLElement>('[data-slot="panel-item"]'),
  ).find((el) => el.textContent?.includes(label));
  if (!row) {
    throw new Error(`No adapter row for "${label}"`);
  }
  return row;
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

  test("renders the adapter list beside the detail panel, with no sub-tab strip", () => {
    renderList();
    // Master-detail, not tabs: the left rail is a row of PanelItems and no
    // Radix tab chrome is rendered.
    expect(document.querySelector('[data-slot="tabs"]')).toBeNull();
    expect(document.querySelectorAll('[data-slot="panel-item"]').length).toBe(
      3,
    );
    expect(document.body.textContent).toContain("Phone");
    expect(document.body.textContent).not.toContain("Phone Calling");
    // Slack (connected) is selected by default: its detail shows the Tag chip
    // + disconnect affordance.
    expect(document.body.textContent).toContain("Connected");
    expect(document.body.textContent).toContain("Disconnect");
  });

  test("the Slack panel consolidates connection state into a single card", () => {
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

  test("selecting connected Telegram reveals its trust-floor dropdown", () => {
    renderList({
      channels: [
        { key: "slack", status: "ready", address: "@vex" },
        { key: "telegram", status: "ready", address: "@vex_bot" },
        { key: "phone", status: "not_configured" },
      ],
      channelPolicies: { telegram: "trusted_contacts" },
      onChannelPolicyChange: () => {},
    });
    // Slack is selected by default and has no channel-wide floor control.
    expect(document.body.textContent).not.toContain("Who can message Vex");

    fireEvent.click(adapterRow("Telegram"));
    expect(document.body.textContent).toContain("Who can message Vex");
    // A connected credential channel shows no token field — parity with
    // Slack's connected card. The credential form belongs to the connect flow.
    expect(document.body.textContent).not.toContain("Bot Token");
  });

  test("connected credential channels show no credential form (Slack parity)", () => {
    renderList({
      channels: [
        { key: "slack", status: "ready", address: "@vex" },
        { key: "telegram", status: "ready", address: "@vex_bot" },
        { key: "phone", status: "ready", address: "+15550100" },
      ],
      onSaveTelegramToken: async () => {},
      onSaveTwilioCredentials: async () => {},
      onDisconnect: () => {},
    });

    // Connected Telegram: connection header (chip + address + Disconnect), no
    // Bot Token field.
    fireEvent.click(adapterRow("Telegram"));
    expect(document.body.textContent).toContain("Connected");
    expect(document.body.textContent).toContain("@vex_bot");
    expect(document.body.textContent).toContain("Disconnect");
    expect(document.body.textContent).not.toContain("Bot Token");

    // Connected Phone: same — no Twilio credential fields.
    fireEvent.click(adapterRow("Phone"));
    expect(document.body.textContent).toContain("Disconnect");
    expect(document.body.textContent).not.toContain("Account SID");
    expect(document.body.textContent).not.toContain("Auth Token");
  });

  // Setup opens on its first step, so the token field is a step away. What
  // these two protect is which surface renders, not which field: the setup
  // wizard rather than the empty state, whose Set up button starts a
  // conversation instead of continuing this one.
  const setupWizardShown = () =>
    document.querySelector('[data-slot="channel-setup-wizard"]') !== null;

  test("selecting a disconnected adapter swaps the empty state for the setup wizard on request", () => {
    renderList();

    fireEvent.click(adapterRow("Telegram"));
    expect(document.body.textContent).toContain("Telegram isn't connected");
    expect(setupWizardShown()).toBe(false);

    const manualButton = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("or connect manually"),
    );
    expect(manualButton).toBeDefined();
    fireEvent.click(manualButton!);

    expect(setupWizardShown()).toBe(true);
    expect(document.body.textContent).not.toContain("Telegram isn't connected");
  });

  test("a half-finished channel offers to finish rather than pitching setup", () => {
    // Credentials stored but not delivering resolves to `incomplete`, which is
    // reachable on any channel with remote checks: Slack lands here when its
    // scopes are silently dropped, Telegram when the webhook never registers.
    // Pitching the channel would hide that setup already happened.
    const prompts: string[] = [];
    renderList({
      channels: [
        { key: "slack", status: "ready", address: "@vex" },
        { key: "telegram", status: "incomplete" },
        { key: "phone", status: "not_configured" },
      ],
      onSetup: (key, incomplete) =>
        prompts.push(`${key}:${incomplete ? "finish" : "fresh"}`),
    });

    fireEvent.click(adapterRow("Telegram"));
    expect(document.body.textContent).toContain("Telegram isn't working yet");
    expect(document.body.textContent).not.toContain("Telegram isn't connected");

    const finish = Array.from(document.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Finish setup with your assistant"),
    );
    expect(finish).toBeDefined();
    fireEvent.click(finish!);

    // The assistant is told setup is part-done, so it picks up where it left
    // off instead of starting over.
    expect(prompts).toEqual(["telegram:finish"]);
  });

  test("a setup deep link selects that adapter and opens the setup wizard directly", () => {
    // The mobile chat-drawer handoff navigates to `?setup=<channel>` to
    // continue setup here — it must land on the wizard, not the empty state
    // whose Set up button would start another conversation.
    renderList({ initialChannel: "telegram" });
    expect(setupWizardShown()).toBe(true);
    expect(document.body.textContent).not.toContain("Telegram isn't connected");
  });

  test("selecting a channel puts it in the URL", () => {
    // The selection is an address, so a row can be linked to and survives a
    // reload rather than resetting to the first one.
    renderList();

    fireEvent.click(adapterRow("Telegram"));

    expect(document.querySelector('[data-testid="path"]')?.textContent).toBe(
      "/assistant/channels/telegram",
    );
  });

  test("opens on the channel the URL names", () => {
    // The other half of the same property: a pasted link lands on its row,
    // showing that channel's panel rather than the first one's.
    renderList({}, "telegram");

    expect(document.body.textContent).toContain("Connect a Telegram bot");
  });

  test("falls back to the first channel when the URL names an unknown one", () => {
    // A stale bookmark, or a plugin channel whose plugin was uninstalled.
    // Showing the first row beats an empty panel.
    renderList({}, "nonexistent");

    expect(document.querySelectorAll('[data-slot="panel-item"]').length).toBe(
      3,
    );
    expect(document.body.textContent).not.toContain("Connect a Telegram bot");
  });
});
