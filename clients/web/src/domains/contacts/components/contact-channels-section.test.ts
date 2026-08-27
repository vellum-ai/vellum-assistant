import { describe, expect, test } from "bun:test";

import type {
  ChannelInfo,
  ContactChannelPayload,
} from "@/domains/contacts/types";

import {
  getChannelActionState,
  hasVerifiableAddress,
  isPluginChannel,
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

describe("isPluginChannel", () => {
  test("is true when source is plugin-namespaced", () => {
    expect(isPluginChannel(channel())).toBe(true);
  });

  test("is false for a built-in channel", () => {
    expect(
      isPluginChannel(
        channel({
          id: "phone",
          source: "default",
          supportsVerification: true,
        }),
      ),
    ).toBe(false);
  });
});

describe("hasVerifiableAddress", () => {
  test("is false for a missing or blank address", () => {
    expect(hasVerifiableAddress(undefined)).toBe(false);
    expect(hasVerifiableAddress(row({ address: "" }))).toBe(false);
    expect(hasVerifiableAddress(row({ address: "   " }))).toBe(false);
  });

  test("is true for a non-empty address", () => {
    expect(hasVerifiableAddress(row({ address: "+15551234567" }))).toBe(true);
  });
});

describe("getChannelActionState", () => {
  test("shows Verify me for an unverified plugin row", () => {
    expect(getChannelActionState(channel(), row())).toEqual({
      kind: "unverified",
    });
  });

  test("shows Verify for a plugin channel with no row yet", () => {
    expect(getChannelActionState(channel(), undefined)).toEqual({
      kind: "unverified",
    });
  });

  test("keeps a built-in challenge channel on setup when there is no row yet", () => {
    expect(
      getChannelActionState(
        channel({
          id: "phone",
          source: "default",
          supportsVerification: true,
        }),
        undefined,
      ),
    ).toEqual({ kind: "setup" });
  });

  test("does not offer verify for a blocked plugin row", () => {
    expect(
      getChannelActionState(channel(), row({ status: "blocked" })),
    ).toEqual({ kind: "none" });
  });
});
