import { describe, expect, test } from "bun:test";

import {
  CHANNEL_EVENT_KINDS,
  ChannelContentRefsSchema,
  ChannelEventKindSchema,
} from "../channel-event.js";

describe("event kind", () => {
  test("covers the gateway's normalizer families", () => {
    expect([...CHANNEL_EVENT_KINDS]).toEqual([
      "message",
      "message_edit",
      "message_delete",
      "reaction",
      "action",
    ]);
  });

  test("each kind is accepted and an unknown one is not", () => {
    for (const kind of CHANNEL_EVENT_KINDS) {
      expect(ChannelEventKindSchema.safeParse(kind).success).toBe(true);
    }
    for (const kind of ["typing", "", "MESSAGE", null, 1]) {
      expect(ChannelEventKindSchema.safeParse(kind).success).toBe(false);
    }
  });
});

describe("content refs", () => {
  test("carries pointers, not bodies", () => {
    expect(Object.keys(ChannelContentRefsSchema.shape).sort()).toEqual([
      "attachmentIds",
      "externalMessageId",
    ]);
  });

  test("a message id is required and attachments are optional", () => {
    expect(ChannelContentRefsSchema.safeParse({}).success).toBe(false);
    expect(
      ChannelContentRefsSchema.safeParse({ externalMessageId: "" }).success,
    ).toBe(false);
    expect(
      ChannelContentRefsSchema.safeParse({ externalMessageId: "m1" }).success,
    ).toBe(true);
    expect(
      ChannelContentRefsSchema.safeParse({
        externalMessageId: "m1",
        attachmentIds: ["att_1", "att_2"],
      }).success,
    ).toBe(true);
  });

  test("attachment ids are bounded and non-empty", () => {
    expect(
      ChannelContentRefsSchema.safeParse({
        externalMessageId: "m1",
        attachmentIds: [""],
      }).success,
    ).toBe(false);
    expect(
      ChannelContentRefsSchema.safeParse({
        externalMessageId: "m1",
        attachmentIds: Array.from({ length: 65 }, (_unused, i) => `att_${i}`),
      }).success,
    ).toBe(false);
  });

  test("no message body is accepted alongside the pointers", () => {
    expect(
      ChannelContentRefsSchema.safeParse({
        externalMessageId: "m1",
        text: "the actual message",
      }).success,
    ).toBe(false);
  });
});
