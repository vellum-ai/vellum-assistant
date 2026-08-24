import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, fireEvent, render } from "@testing-library/react";

import { ChannelAdapterList } from "@/domains/channels/components/channel-adapter-list";
import type {
  AssistantChannelState,
  PluginChannelSummary,
} from "@/types/channel-types";

const CHANNELS: AssistantChannelState[] = [
  { key: "slack", status: "ready", configured: true, address: "@vex" },
  { key: "telegram", status: "not_configured", configured: false },
  { key: "phone", status: "not_configured", configured: false },
];

const PLUGIN_CHANNELS: PluginChannelSummary[] = [
  {
    plugin: "courier",
    key: "plugins-courier",
    label: "Courier",
    description: "Reach the assistant by carrier pigeon.",
    icon: "send",
  },
];

afterEach(() => {
  cleanup();
});

/** The adapter row whose label matches, keyed off the `PanelItem` slot. */
function rowFor(label: string): HTMLElement {
  const row = Array.from(
    document.querySelectorAll<HTMLElement>('[data-slot="panel-item"]'),
  ).find((el) => el.textContent?.includes(label));
  if (!row) {
    throw new Error(`No adapter row for "${label}"`);
  }
  return row;
}

describe("ChannelAdapterList", () => {
  test("renders a row for every adapter", () => {
    render(
      <ChannelAdapterList
        channels={CHANNELS}
        selectedKey="slack"
        onSelect={() => {}}
      />,
    );
    expect(document.querySelectorAll('[data-slot="panel-item"]').length).toBe(
      3,
    );
    expect(document.body.textContent).toContain("Slack");
    expect(document.body.textContent).toContain("Telegram");
    // The short "Phone" label, not the "Phone Calling" disconnect subject.
    expect(document.body.textContent).toContain("Phone");
    expect(document.body.textContent).not.toContain("Phone Calling");
  });

  test("badges the connected adapter and marks the rest not connected", () => {
    render(
      <ChannelAdapterList
        channels={CHANNELS}
        selectedKey="slack"
        onSelect={() => {}}
      />,
    );
    expect(rowFor("Slack").textContent).toContain("Connected");
    expect(rowFor("Telegram").textContent).toContain("Not connected");
    expect(rowFor("Phone").textContent).toContain("Not connected");
  });

  test("names each row with its adapter and status for screen readers", () => {
    render(
      <ChannelAdapterList
        channels={CHANNELS}
        selectedKey="slack"
        onSelect={() => {}}
      />,
    );
    // PanelItem forwards the label to the button's aria-label, so it must carry
    // the connection status — not just the adapter name.
    expect(rowFor("Slack").getAttribute("aria-label")).toBe("Slack, Connected");
    expect(rowFor("Telegram").getAttribute("aria-label")).toBe(
      "Telegram, Not connected",
    );
  });

  test("marks only the selected row as the current page", () => {
    render(
      <ChannelAdapterList
        channels={CHANNELS}
        selectedKey="telegram"
        onSelect={() => {}}
      />,
    );
    expect(rowFor("Telegram").getAttribute("aria-current")).toBe("page");
    expect(rowFor("Slack").getAttribute("aria-current")).toBeNull();
    expect(rowFor("Phone").getAttribute("aria-current")).toBeNull();
  });

  test("selecting a row reports that adapter's key", () => {
    const selected: string[] = [];
    render(
      <ChannelAdapterList
        channels={CHANNELS}
        selectedKey="slack"
        onSelect={(key) => selected.push(key)}
      />,
    );
    fireEvent.click(rowFor("Telegram"));
    fireEvent.click(rowFor("Phone"));
    expect(selected).toEqual(["telegram", "phone"]);
  });

  test("rows are focusable native buttons, matching the Contacts EntriesList", () => {
    render(
      <ChannelAdapterList
        channels={CHANNELS}
        selectedKey="slack"
        onSelect={() => {}}
      />,
    );
    const phone = rowFor("Phone");
    // Same affordance as the Contacts EntriesList rows: a native <button>, so
    // it sits in the tab order and Enter/Space activate it natively — there's
    // no custom key handler to keep in parity with.
    expect(phone.tagName).toBe("BUTTON");
    expect(phone.getAttribute("tabindex")).not.toBe("-1");
    phone.focus();
    expect(document.activeElement).toBe(phone);
  });

  /**
   * Naming the section belongs to whatever mounts the rail (the chrome's
   * `<h1>` on desktop, the drawer title on mobile), so the card must not
   * say "Channels" itself. Counting headings by that name is what catches
   * a second copy; `IntelligenceLayout`'s test holds up the first.
   */
  test("leaves naming the section to the surface that mounts it", () => {
    render(
      <ChannelAdapterList
        channels={CHANNELS}
        pluginChannels={PLUGIN_CHANNELS}
        selectedKey="slack"
        onSelect={() => {}}
      />,
    );

    // Rows rendered, so the count below is not vacuously zero.
    expect(document.querySelectorAll('[data-slot="panel-item"]').length).toBe(
      4,
    );

    const named = Array.from(
      document.querySelectorAll("h1, h2, h3, h4, h5, h6"),
    ).filter((el) => el.textContent?.trim() === "Channels");
    expect(named.length).toBe(0);
  });

  test("lists channels a plugin brings in the same list as the rest", () => {
    render(
      <ChannelAdapterList
        channels={CHANNELS}
        pluginChannels={PLUGIN_CHANNELS}
        selectedKey="slack"
        onSelect={() => {}}
      />,
    );

    expect(document.querySelectorAll('[data-slot="panel-item"]').length).toBe(
      4,
    );
    expect(document.body.textContent).not.toContain("From plugins");
    expect(document.body.textContent).toContain("Courier");
  });

  test("looks untouched when no plugin brings a channel", () => {
    // The common case: the rail is the three built-ins and nothing else.
    render(
      <ChannelAdapterList
        channels={CHANNELS}
        selectedKey="slack"
        onSelect={() => {}}
      />,
    );

    expect(document.querySelectorAll('[data-slot="panel-item"]').length).toBe(
      3,
    );
  });

  test("selects a plugin channel by its namespaced id", () => {
    // The id is what keeps a plugin row from colliding with an adapter key.
    let selected: string | undefined;
    render(
      <ChannelAdapterList
        channels={CHANNELS}
        pluginChannels={PLUGIN_CHANNELS}
        selectedKey="slack"
        onSelect={(key) => {
          selected = key;
        }}
      />,
    );

    fireEvent.click(rowFor("Courier"));
    expect(selected).toBe("plugins-courier");
  });

  test("lists a plugin channel whose manifest names no icon", () => {
    // Presentation is best-effort on the assistant, so the rail has to render
    // a channel that arrives with nothing but a label.
    render(
      <ChannelAdapterList
        channels={[]}
        pluginChannels={[
          {
            plugin: "meeting-bot",
            key: "plugins-meeting-bot",
            label: "Meeting Bot",
          },
        ]}
        selectedKey="plugins-meeting-bot"
        onSelect={() => {}}
      />,
    );

    expect(rowFor("Meeting Bot")).toBeDefined();
  });

  test("carries no connection badge on a plugin row", () => {
    // Nothing here can answer it for an arbitrary plugin, and a badge that
    // always read "Not connected" would be a claim rather than a gap.
    render(
      <ChannelAdapterList
        channels={[]}
        pluginChannels={PLUGIN_CHANNELS}
        selectedKey="plugins-courier"
        onSelect={() => {}}
      />,
    );

    expect(rowFor("Courier").textContent).not.toContain("Not connected");
  });
});
