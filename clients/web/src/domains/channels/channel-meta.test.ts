import { describe, expect, test } from "bun:test";

import { CHANNEL_META } from "@/domains/channels/channel-meta";
import {
  CHANNEL_SETUP_TYPES,
  type ChannelSetupType,
} from "@/stores/viewer-store";
import { SETUP_CHANNEL_IDS } from "@/types/channel-types";

/**
 * Both capabilities are declared per channel, so a channel that has neither
 * is offered neither. A branch cannot express that, and its last arm becomes
 * the answer for anything it does not name.
 */
describe("channel capabilities are declared, not inferred", () => {
  test("each channel declares the form it is set up through", () => {
    // The invariant is that the field is set only where a form exists, so a
    // channel added later inherits nothing rather than the last arm of a
    // branch.
    expect(CHANNEL_META.slack.credentialForm).toBe("slack-wizard");
    expect(CHANNEL_META.telegram.credentialForm).toBe("telegram-token");
    expect(CHANNEL_META.phone.credentialForm).toBe("twilio-credentials");
    // Discord's in-product form arrives with its config API; until then the
    // declared absence is what routes its setup to the guided flow.
    expect(CHANNEL_META.discord.credentialForm).toBeUndefined();
  });

  test("only the phone channel can reach the Twilio form", () => {
    const twilio = SETUP_CHANNEL_IDS.filter(
      (id) => CHANNEL_META[id].credentialForm === "twilio-credentials",
    );
    expect(twilio).toEqual(["phone"]);
  });

  test("disconnect copy exists exactly where a route can clear credentials", () => {
    // The absence of copy is what keeps the button unoffered, so each value
    // is pinned: a channel gaining a disconnect route must add its copy here,
    // and one declaring copy without a route would offer a dead confirm.
    expect(CHANNEL_META.slack.disconnectMessageKey).toBeDefined();
    expect(CHANNEL_META.telegram.disconnectMessageKey).toBeDefined();
    expect(CHANNEL_META.phone.disconnectMessageKey).toBeDefined();
    expect(CHANNEL_META.discord.disconnectMessageKey).toBeUndefined();
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
      (id): id is ChannelSetupType =>
        CHANNEL_META[id].credentialForm !== undefined,
    );
    expect([...CHANNEL_SETUP_TYPES]).toEqual(withForm);
  });

  test("every channel it accepts has a renderer in the drawer", () => {
    // The drawer is a credential form, so accepting a channel it cannot draw
    // would show another channel's connected copy over an empty body.
    // `CHANNEL_BRAND_LABEL` is an exhaustive record over this set, so a
    // channel reaching the drawer without a renderer fails to compile rather
    // than rendering another channel's copy. This pins the set it is over.
    for (const id of CHANNEL_SETUP_TYPES) {
      expect(CHANNEL_META[id].credentialForm).toBeDefined();
    }
  });
});
