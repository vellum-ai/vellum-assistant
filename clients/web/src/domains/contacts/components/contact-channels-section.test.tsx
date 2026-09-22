import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render } from "@testing-library/react";

import type {
  ChannelInfo,
  ContactChannelPayload,
} from "@/domains/contacts/types";

import { ContactChannelsSection } from "./contact-channels-section";

afterEach(() => {
  cleanup();
});

function pluginChannel(overrides: Partial<ChannelInfo> = {}): ChannelInfo {
  return {
    id: "imessage",
    source: "plugin:imessage",
    label: "iMessage",
    subtitle: "Provided by the iMessage plugin",
    icon: "message-square",
    supportsVerification: false,
    setupMessages: {
      guardian: "I want to set up iMessage. Can you help me?",
      contact: "",
    },
    ...overrides,
  };
}

function phoneChannel(): ChannelInfo {
  return {
    id: "phone",
    source: "default",
    label: "Phone Calling",
    subtitle: "Call or text your assistant via phone",
    icon: "phone",
    supportsVerification: true,
    setupMessages: {
      guardian:
        "I'd like to verify my identity as your guardian for phone calls.",
      contact: "",
    },
  };
}

function slackChannel(): ChannelInfo {
  return {
    id: "slack",
    source: "default",
    label: "Slack",
    subtitle: "Message your assistant from Slack",
    icon: "hash",
    supportsVerification: true,
    setupMessages: { guardian: "", contact: "" },
  };
}

function row(
  overrides: Partial<ContactChannelPayload> = {},
): ContactChannelPayload {
  return {
    id: "ch-1",
    type: "imessage",
    address: "+15551234567",
    status: "unverified",
    ...overrides,
  } as ContactChannelPayload;
}

function getButton(label: string): HTMLButtonElement {
  const buttons = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  );
  const match = buttons.find((b) => b.textContent?.trim() === label);
  if (!match) {
    throw new Error(
      `expected a "${label}" button — saw: ${buttons
        .map((b) => `"${b.textContent?.trim()}"`)
        .join(", ")}`,
    );
  }
  return match;
}

function getDialogVerifyButton(): HTMLButtonElement {
  const dialog = document.querySelector('[data-slot="modal-content"]');
  if (!dialog) {
    throw new Error("expected the verify modal to be open");
  }
  const match = Array.from(dialog.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === "Verify",
  );
  if (!match) {
    throw new Error("expected a Verify button inside the modal");
  }
  return match;
}

describe("ContactChannelsSection plugin verify", () => {
  test("opens the address modal for a plugin channel with no row", () => {
    const onSetupChannel = mock(() => {});
    const onVerifyChannel = mock(() => {});

    render(
      <ContactChannelsSection
        contactChannels={[]}
        availableChannels={[pluginChannel()]}
        setupLabel="Verify me"
        onSetupChannel={onSetupChannel}
        onVerifyChannel={onVerifyChannel}
      />,
    );

    fireEvent.click(getButton("Verify"));

    expect(onSetupChannel).not.toHaveBeenCalled();
    expect(onVerifyChannel).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Verify iMessage");
    expect(
      document.querySelector<HTMLInputElement>(
        'input[placeholder="+15551234567"]',
      ),
    ).not.toBeNull();
    expect(getDialogVerifyButton().disabled).toBe(true);
  });

  test("submits the entered address instead of starting setup chat", () => {
    const onSetupChannel = mock(() => {});
    const onVerifyChannel = mock((_type: string, _address?: string) => {});

    render(
      <ContactChannelsSection
        contactChannels={[]}
        availableChannels={[pluginChannel()]}
        setupLabel="Verify me"
        onSetupChannel={onSetupChannel}
        onVerifyChannel={onVerifyChannel}
      />,
    );

    fireEvent.click(getButton("Verify"));
    const input = document.querySelector<HTMLInputElement>(
      'input[placeholder="+15551234567"]',
    );
    if (!input) {
      throw new Error("expected the address field");
    }
    fireEvent.change(input, { target: { value: "+15551234567" } });
    fireEvent.click(getDialogVerifyButton());

    expect(onSetupChannel).not.toHaveBeenCalled();
    expect(onVerifyChannel).toHaveBeenCalledTimes(1);
    expect(onVerifyChannel.mock.calls[0]).toEqual(["imessage", "+15551234567"]);
  });

  test("confirms an existing plugin address without asking for a new one", () => {
    const onVerifyChannel = mock((_type: string, _address?: string) => {});

    render(
      <ContactChannelsSection
        contactChannels={[row()]}
        availableChannels={[pluginChannel()]}
        onVerifyChannel={onVerifyChannel}
      />,
    );

    fireEvent.click(getButton("Verify"));

    expect(
      document.querySelector('input[placeholder="+15551234567"]'),
    ).toBeNull();
    fireEvent.click(getDialogVerifyButton());
    expect(onVerifyChannel).toHaveBeenCalledTimes(1);
    expect(onVerifyChannel.mock.calls[0]).toEqual(["imessage", undefined]);
  });

  test("keeps Phone on the setup conversation when there is no row", () => {
    const onSetupChannel = mock(() => {});

    render(
      <ContactChannelsSection
        contactChannels={[]}
        availableChannels={[phoneChannel()]}
        setupLabel="Verify me"
        onSetupChannel={onSetupChannel}
      />,
    );

    fireEvent.click(getButton("Verify me"));
    expect(onSetupChannel).toHaveBeenCalledTimes(1);
    expect(onSetupChannel.mock.calls[0]).toEqual(["phone"]);
    expect(document.querySelector('[data-slot="modal-content"]')).toBeNull();
  });
});

/**
 * One contact with a row in every action state, so each of the four actions
 * is on screen at once: a verified plugin row (Revoke), an unverified phone
 * row (Verify), and Slack with no row (Link account, Invite).
 */
function renderEveryAction(actionsDisabled?: boolean) {
  render(
    <ContactChannelsSection
      contactChannels={[
        row({ status: "verified" }),
        row({ id: "ch-2", type: "phone", address: "+15555550100" }),
      ]}
      availableChannels={[pluginChannel(), phoneChannel(), slackChannel()]}
      actionsDisabled={actionsDisabled}
      onSetupChannel={() => {}}
      onVerifyChannel={() => {}}
      onRevokeChannel={() => {}}
      onLinkAccount={() => {}}
    />,
  );
}

const ROW_ACTIONS = ["Revoke", "Verify", "Link account", "Invite"];

describe("ContactChannelsSection row actions", () => {
  test.each(ROW_ACTIONS)("offers %s while nothing is pending", (label) => {
    renderEveryAction();
    expect(getButton(label).disabled).toBe(false);
  });

  // A request that removes the contact is in flight. Link account is the
  // damaging one: it upserts the id the server is deleting.
  test.each(ROW_ACTIONS)("blocks %s while actions are disabled", (label) => {
    renderEveryAction(true);
    expect(getButton(label).disabled).toBe(true);
  });
});
