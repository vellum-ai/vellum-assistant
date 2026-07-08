import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, fireEvent, render } from "@testing-library/react";

import { ChannelAdapterList } from "@/domains/channels/components/channel-adapter-list";
import type { AssistantChannelState } from "@/types/channel-types";

const CHANNELS: AssistantChannelState[] = [
  { key: "slack", status: "ready", address: "@vex" },
  { key: "telegram", status: "not_configured" },
  { key: "phone", status: "not_configured" },
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
});
