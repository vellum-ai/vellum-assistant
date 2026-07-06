import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, render } from "@testing-library/react";

import { AssistantChannelsDetail } from "@/domains/contacts/components/assistant-channels-detail";
import { AssistantChannelsList } from "@/domains/contacts/components/assistant-channels-list";
import type { AssistantChannelState } from "@/domains/contacts/types";

const CHANNELS: AssistantChannelState[] = [
  { key: "slack", status: "ready", address: "@vex" },
  { key: "telegram", status: "not_configured" },
  { key: "phone", status: "not_configured" },
];

afterEach(() => {
  cleanup();
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
    expect(document.body.textContent).toContain("Phone Calling");
  });
});
