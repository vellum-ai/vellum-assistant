import { describe, expect, test } from "bun:test";

import {
  DISCORD_GATEWAY_INTENTS,
  DISCORD_INTENTS,
  PRIVILEGED_DISCORD_INTENTS,
} from "./intents.js";
import "../__tests__/test-preload.js";

describe("DISCORD_INTENTS", () => {
  test("bit positions match Discord's documented shifts", () => {
    // Wrong by one bit is a silent subscription to the wrong event family, so
    // these are pinned against the published values rather than recomputed.
    expect(DISCORD_INTENTS.GUILDS).toBe(1);
    expect(DISCORD_INTENTS.GUILD_MEMBERS).toBe(2);
    expect(DISCORD_INTENTS.GUILD_PRESENCES).toBe(256);
    expect(DISCORD_INTENTS.GUILD_MESSAGES).toBe(512);
    expect(DISCORD_INTENTS.GUILD_MESSAGE_REACTIONS).toBe(1024);
    expect(DISCORD_INTENTS.DIRECT_MESSAGES).toBe(4096);
    expect(DISCORD_INTENTS.DIRECT_MESSAGE_REACTIONS).toBe(8192);
    expect(DISCORD_INTENTS.MESSAGE_CONTENT).toBe(32768);
  });
});

describe("DISCORD_GATEWAY_INTENTS", () => {
  test("PRIVILEGED_DISCORD_INTENTS lists every intent Discord gates", () => {
    // The guard below is only as good as this list. Discord gates three:
    // omitting one leaves a privileged intent the invariant cannot see, which
    // is a safeguard that reports success while covering two thirds of the
    // surface.
    expect([...PRIVILEGED_DISCORD_INTENTS].sort((a, b) => a - b)).toEqual([
      DISCORD_INTENTS.GUILD_MEMBERS,
      DISCORD_INTENTS.GUILD_PRESENCES,
      DISCORD_INTENTS.MESSAGE_CONTENT,
    ]);
  });

  test("requests no privileged intent", () => {
    // The load-bearing assertion. Mention-gating puts every message this
    // client acts on inside Discord's content exemption, so the privileged
    // MESSAGE_CONTENT intent buys nothing while subjecting the app to portal
    // approval and annual reapplication. Widening the bitmask to a privileged
    // intent is a product decision with an external approval dependency — it
    // should fail here first rather than be discovered at IDENTIFY.
    for (const privileged of PRIVILEGED_DISCORD_INTENTS) {
      expect(DISCORD_GATEWAY_INTENTS & privileged).toBe(0);
    }
  });

  test("subscribes to guild lifecycle and guild messages", () => {
    expect(DISCORD_GATEWAY_INTENTS & DISCORD_INTENTS.GUILDS).not.toBe(0);
    expect(DISCORD_GATEWAY_INTENTS & DISCORD_INTENTS.GUILD_MESSAGES).not.toBe(
      0,
    );
  });

  test("subscribes to direct messages, the private lane to one person", () => {
    // Verification codes are answered in a DM and guardian outcome notices are
    // delivered to one, so without this bit the DM half of the channel is
    // deaf: the assistant can send into a DM and never hear the reply.
    expect(DISCORD_GATEWAY_INTENTS & DISCORD_INTENTS.DIRECT_MESSAGES).not.toBe(
      0,
    );
  });

  test("subscribes to reactions in both guild channels and DMs", () => {
    // A guardian's approval-by-reaction can land on an approval card in
    // either place; without these bits the reaction path is deaf while the
    // rest of the channel works, which nothing at IDENTIFY would surface.
    expect(
      DISCORD_GATEWAY_INTENTS & DISCORD_INTENTS.GUILD_MESSAGE_REACTIONS,
    ).not.toBe(0);
    expect(
      DISCORD_GATEWAY_INTENTS & DISCORD_INTENTS.DIRECT_MESSAGE_REACTIONS,
    ).not.toBe(0);
  });

  test("DIRECT_MESSAGES is not one of the gated intents", () => {
    // The reason the lane above costs nothing. If Discord ever moves it into
    // the privileged set, `PRIVILEGED_DISCORD_INTENTS` gains it and the
    // no-privileged-intent assertion above starts failing, which is the
    // intended way to find out.
    expect([...PRIVILEGED_DISCORD_INTENTS]).not.toContain(
      DISCORD_INTENTS.DIRECT_MESSAGES,
    );
  });
});
