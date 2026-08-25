import { describe, expect, test } from "bun:test";

import { CHANNEL_META } from "@/domains/channels/channel-meta";
import { CHANNEL_SETUP_TYPES, isChannelSetupType } from "@/stores/viewer-store";
import { SETUP_CHANNEL_IDS } from "@/types/channel-types";

/**
 * Two capabilities on the Channels tab used to be inferred from a branch's
 * last arm rather than declared, so a channel that had neither got another
 * channel's. Discord asked for a Twilio Account SID and saved phone
 * credentials under a Discord heading. These pin the capability as data.
 */
describe("channel capabilities are declared, not inferred", () => {
  test("a channel with no manual credential form declares none", () => {
    // Not "discord is absent": the invariant is that the field is only set
    // where a form exists, so a channel added later inherits nothing.
    expect(CHANNEL_META.discord.manualEntry).toBeUndefined();
    expect(CHANNEL_META.telegram.manualEntry).toBe("telegram-token");
    expect(CHANNEL_META.phone.manualEntry).toBe("twilio-credentials");
  });

  test("only channels with a form may reach the Twilio one", () => {
    const twilio = SETUP_CHANNEL_IDS.filter(
      (id) => CHANNEL_META[id].manualEntry === "twilio-credentials",
    );
    expect(twilio).toEqual(["phone"]);
  });

  test("a channel with no disconnect route declares no disconnect copy", () => {
    expect(CHANNEL_META.discord.disconnectMessageKey).toBeUndefined();
    for (const id of ["slack", "telegram", "phone"] as const) {
      expect(CHANNEL_META[id].disconnectMessageKey).toBeDefined();
    }
  });

  test("the setup drawer accepts only channels whose form it renders", () => {
    for (const id of CHANNEL_SETUP_TYPES) {
      expect(CHANNEL_META[id].manualEntry).toBeDefined();
    }
    // The drawer is a credential form, so a channel without one must not
    // reach it: it would render another channel's connected copy.
    expect(isChannelSetupType("discord")).toBe(false);
  });
});
