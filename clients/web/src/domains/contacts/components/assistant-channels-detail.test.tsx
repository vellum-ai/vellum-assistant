import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, render } from "@testing-library/react";

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

describe("AssistantChannelsDetail identity card", () => {
  test("renders the assistant header card by default (Contacts detail view)", () => {
    render(
      <AssistantChannelsDetail assistantName="Vex" channels={CHANNELS} />,
    );
    expect(document.body.textContent).toContain("Vex (Your Assistant)");
  });

  test("hides the assistant header card on the standalone Channels tab", () => {
    render(
      <AssistantChannelsDetail
        assistantName="Vex"
        showIdentityCard={false}
        channels={CHANNELS}
      />,
    );
    expect(document.body.textContent).not.toContain("Vex (Your Assistant)");
    // The channel list itself still renders.
    expect(document.body.textContent).toContain("Channels");
    expect(document.body.textContent).toContain("Slack");
  });
});
