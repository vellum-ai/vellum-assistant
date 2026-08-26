import { describe, expect, test } from "bun:test";

import type {
  ChannelInfo,
  ContactChannelPayload,
} from "@/domains/contacts/types";

import {
  getChannelActionState,
  offersManualVerify,
} from "./contact-channels-section";

function channel(overrides: Partial<ChannelInfo> = {}): ChannelInfo {
  return {
    id: "imessage",
    source: "plugin:imessage",
    label: "iMessage",
    subtitle: "Provided by the iMessage plugin",
    icon: "message-square",
    supportsVerification: false,
    setupMessages: { guardian: "", contact: "" },
    ...overrides,
  };
}

function row(
  overrides: Partial<ContactChannelPayload> = {},
): ContactChannelPayload {
  return {
    id: "ch-1",
    type: "imessage",
    address: "",
    status: "unverified",
    ...overrides,
  } as ContactChannelPayload;
}

describe("offersManualVerify", () => {
  test("is true for a built-in challenge channel", () => {
    expect(
      offersManualVerify(
        channel({
          id: "phone",
          source: "default",
          supportsVerification: true,
        }),
      ),
    ).toBe(true);
  });

  test("is true for a plugin channel even without a challenge flow", () => {
    expect(offersManualVerify(channel())).toBe(true);
  });

  test("is false for email", () => {
    expect(
      offersManualVerify(
        channel({
          id: "email",
          source: "default",
          supportsVerification: false,
        }),
      ),
    ).toBe(false);
  });
});

describe("getChannelActionState", () => {
  test("shows Verify me for an unverified plugin row", () => {
    expect(getChannelActionState(channel(), row())).toEqual({
      kind: "unverified",
    });
  });

  test("keeps a plugin channel on setup when there is no row yet", () => {
    expect(getChannelActionState(channel(), undefined)).toEqual({
      kind: "setup",
    });
  });
});
