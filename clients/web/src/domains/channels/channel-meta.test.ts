import { describe, expect, test } from "bun:test";

import { CHANNEL_META } from "@/domains/channels/channel-meta";
import { CHANNEL_SETUP_TYPES, isChannelSetupType } from "@/stores/viewer-store";
import { SETUP_CHANNEL_IDS } from "@/types/channel-types";

/**
 * Both capabilities are declared per channel, so a channel that has neither
 * is offered neither. A branch cannot express that, and its last arm becomes
 * the answer for anything it does not name.
 */
describe("channel capabilities are declared, not inferred", () => {
  test("a channel with no credential form declares none", () => {
    // The invariant is that the field is set only where a form exists, so a
    // channel added later inherits nothing.
    expect(CHANNEL_META.discord.credentialForm).toBeUndefined();
    expect(CHANNEL_META.slack.credentialForm).toBe("slack-wizard");
    expect(CHANNEL_META.telegram.credentialForm).toBe("telegram-token");
    expect(CHANNEL_META.phone.credentialForm).toBe("twilio-credentials");
  });

  test("only the phone channel can reach the Twilio form", () => {
    const twilio = SETUP_CHANNEL_IDS.filter(
      (id) => CHANNEL_META[id].credentialForm === "twilio-credentials",
    );
    expect(twilio).toEqual(["phone"]);
  });

  test("a channel with no disconnect route declares no disconnect copy", () => {
    expect(CHANNEL_META.discord.disconnectMessageKey).toBeUndefined();
    for (const id of ["slack", "telegram", "phone"] as const) {
      expect(CHANNEL_META[id].disconnectMessageKey).toBeDefined();
    }
  });
});

/**
 * The drawer and the Channels tab render the same wizards and differ only in
 * where they are mounted, so which channels have a form is one fact and the
 * drawer's set derives from it.
 */
describe("the setup drawer derives from the same fact as the tab", () => {
  test("it accepts exactly the channels that declare a form", () => {
    const withForm = SETUP_CHANNEL_IDS.filter(
      (id) => CHANNEL_META[id].credentialForm !== undefined,
    );
    expect([...CHANNEL_SETUP_TYPES] as string[]).toEqual([
      ...withForm,
    ] as string[]);
  });

  test("a channel with no form cannot reach it", () => {
    // It would render another channel's connected copy over an empty body.
    expect(isChannelSetupType("discord")).toBe(false);
    expect(isChannelSetupType("slack")).toBe(true);
  });
});
