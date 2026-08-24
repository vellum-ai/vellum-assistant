import { describe, expect, test } from "bun:test";

import { audienceForReader } from "../message-audience.js";

describe("audienceForReader", () => {
  test("restricts a reply in a Slack channel to the named reader", () => {
    expect(audienceForReader("slack", "C0ROOM", "U0READER")).toEqual({
      kind: "oneReader",
      userId: "U0READER",
    });
  });

  test("leaves a Slack DM unrestricted", () => {
    // Nobody else can read a DM, so restricting buys no privacy and costs
    // durability: an ephemeral message does not survive a reload.
    expect(audienceForReader("slack", "D0DIRECT", "U0READER")).toBeUndefined();
  });

  test("restricts a private group, which several readers share", () => {
    // A `G` id is a shared room like a `C` one. Testing for a DM rather than
    // for a channel id is what keeps this from leaking into the group.
    expect(audienceForReader("slack", "G0PRIVATE", "U0READER")).toEqual({
      kind: "oneReader",
      userId: "U0READER",
    });
  });

  test("leaves every other channel unrestricted", () => {
    for (const channel of ["telegram", "discord", "whatsapp", "email"]) {
      expect(
        audienceForReader(channel, "C0ROOM", "U0READER"),
        `${channel} has no way to show one reader a message in a shared room`,
      ).toBeUndefined();
    }
  });

  test("stays unrestricted when there is no reader to name", () => {
    expect(audienceForReader("slack", "C0ROOM", undefined)).toBeUndefined();
    expect(audienceForReader("slack", "C0ROOM", null)).toBeUndefined();
  });

  test("tolerates an absent channel or room rather than throwing", () => {
    // Several callers hold values that were never narrowed, so the answer for
    // an unknown channel has to be the safe one rather than an exception.
    expect(audienceForReader(undefined, "C0ROOM", "U0READER")).toBeUndefined();
    expect(audienceForReader(null, "C0ROOM", "U0READER")).toBeUndefined();
    expect(audienceForReader("slack", null, "U0READER")).toBeUndefined();
  });
});
