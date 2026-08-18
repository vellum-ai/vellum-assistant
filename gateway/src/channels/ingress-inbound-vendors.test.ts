/**
 * The declaration language against real vendor payloads.
 *
 * The question this answers is whether a manifest can express what a plugin's
 * webhook normalizer expresses in code. If it cannot, the gateway has to take
 * the plugin's word for what a delivery says, which means crossing into the
 * assistant to ask before the gate can run, and the gate is the thing that must
 * not move.
 *
 * So these are not schema tests. They are the two shipping vendors' actual
 * webhook envelopes, read by a declaration written the way a plugin author
 * would write one, checked against what `imessage`'s normalizers produce.
 */

import { describe, expect, it } from "bun:test";

import { IngressInboundSchema } from "./ingress-inbound.js";
import { readPluginInbound } from "./plugin-inbound.js";

const AT = "2026-02-01T00:00:00.000Z";

function read(plugin: string, raw: unknown, declaration: unknown) {
  return readPluginInbound({
    plugin,
    inbound: IngressInboundSchema.parse(declaration),
    body: raw,
    receivedAt: AT,
  });
}

/* ------------------------------------------------------------------ *
 * Comms
 * ------------------------------------------------------------------ */

/** `{ event, message }`, the envelope Comms delivers. */
const COMMS = {
  identity: "phone",
  fields: {
    content: "message.body",
    conversationExternalId: ["message.conversation_id", "message.from"],
    externalMessageId: "message.id",
    actorExternalId: "message.from",
    chatType: {
      from: "message.channel",
      map: { imessage: "imessage" },
      default: "sms",
    },
  },
};

function commsDelivery(overrides: Record<string, unknown> = {}) {
  return {
    event: "comms.message.received",
    message: {
      id: "msg_01",
      direction: "inbound",
      body: "hello",
      channel: "imessage",
      conversation_id: "conv_abc",
      from: "+12025550142",
      ...overrides,
    },
  };
}

describe("a Comms declaration", () => {
  it("reads an inbound message the way the plugin's normalizer does", () => {
    const result = read("imessage", commsDelivery(), COMMS);

    expect(result.status).toBe("event");
    if (result.status !== "event") return;
    expect(result.event.message.content).toBe("hello");
    expect(result.event.message.conversationExternalId).toBe(
      "imessage:conv_abc",
    );
    expect(result.event.actor.actorExternalId).toBe("imessage:+12025550142");
    expect(result.event.source.chatType).toBe("imessage");
  });

  it("falls back to the sender when there is no conversation id", () => {
    // A 1:1 thread that Comms has not assigned a conversation to still has to
    // bind somewhere, and the sender is the only stable address available.
    const raw = commsDelivery();
    delete (raw.message as Record<string, unknown>).conversation_id;

    const result = read("imessage", raw, COMMS);
    expect(result.status).toBe("event");
    if (result.status !== "event") return;
    expect(result.event.message.conversationExternalId).toBe(
      "imessage:+12025550142",
    );
  });

  it("reads an SMS as sms and anything unrecognized as sms too", () => {
    // Not cosmetic. SMS sender ids are spoofable and iMessage identities are
    // not, so an unknown value has to land on the conservative side.
    for (const channel of ["sms", "rcs", undefined]) {
      const raw = commsDelivery({ channel });
      const result = read("imessage", raw, COMMS);
      expect(result.status).toBe("event");
      if (result.status !== "event") continue;
      expect(result.event.source.chatType).toBe("sms");
    }
  });

  it("finds no message in a delivery test, leaving it for the plugin", () => {
    // A ping carries no sender and no content. The gateway has nobody to gate
    // and nothing to admit, so it reads as absent rather than as broken, and
    // what the event means stays the plugin\'s business.
    const result = read("imessage", { event: "comms.ping" }, COMMS);
    expect(result.status).toBe("none");
  });
});

/* ------------------------------------------------------------------ *
 * Photon
 * ------------------------------------------------------------------ */

/**
 * `{ event, space, message: { sender, space, content } }`.
 *
 * The two things a single path could not express are both here. The
 * conversation falls back from `message.space.id` to `space.id`, which in code
 * is `message.space ?? event.space`, and the platform is mapped to the two
 * values admission acts on. The vendor\'s own casing is used for the map key,
 * because a declaration should be able to quote what the wire says.
 */
const PHOTON = {
  identity: "phone",
  fields: {
    content: "message.content.text",
    conversationExternalId: ["message.space.id", "space.id"],
    externalMessageId: "message.id",
    actorExternalId: "message.sender.id",
    chatType: {
      from: ["message.platform", "space.platform"],
      map: { iMessage: "imessage" },
      default: "sms",
    },
  },
};

function photonDelivery(overrides: Record<string, unknown> = {}) {
  return {
    event: "messages",
    space: { id: "any;-;+12025550142", platform: "iMessage", type: "dm" },
    message: {
      id: "p_9",
      platform: "iMessage",
      direction: "inbound",
      sender: { id: "+12025550142" },
      content: { type: "text", text: "hey, what time is dinner?" },
      ...overrides,
    },
  };
}

describe("a Photon declaration", () => {
  it("reads the documented webhook delivery", () => {
    const result = read("imessage", photonDelivery(), PHOTON);

    expect(result.status).toBe("event");
    if (result.status !== "event") return;
    expect(result.event.message.content).toBe("hey, what time is dinner?");
    // The space id is the chat guid a reply is addressed to, so binding on it
    // is what lets a reply skip chat resolution.
    expect(result.event.message.conversationExternalId).toBe(
      "imessage:any;-;+12025550142",
    );
    expect(result.event.actor.actorExternalId).toBe("imessage:+12025550142");
    expect(result.event.source.chatType).toBe("imessage");
  });

  it("prefers the message's own space over the envelope's", () => {
    // `message.space ?? event.space` in code. A group delivery carries the
    // room on the message, and binding to the envelope would put every room's
    // messages in one conversation.
    const raw = photonDelivery({
      space: { id: "any;-;group-7", platform: "iMessage" },
    });

    const result = read("imessage", raw, PHOTON);
    expect(result.status).toBe("event");
    if (result.status !== "event") return;
    expect(result.event.message.conversationExternalId).toBe(
      "imessage:any;-;group-7",
    );
  });

  it("maps the platform case-insensitively", () => {
    // Photon spells it `iMessage`. A map that missed on capitalisation would
    // silently downgrade every blue bubble to the spoofable-sender treatment.
    const result = read("imessage", photonDelivery(), PHOTON);
    expect(result.status).toBe("event");
    if (result.status !== "event") return;
    expect(result.event.source.chatType).toBe("imessage");
  });

  it("reads an unrecognized platform as sms", () => {
    const raw = photonDelivery({ platform: "RCS" });
    (raw.space as Record<string, unknown>).platform = "RCS";

    const result = read("imessage", raw, PHOTON);
    expect(result.status).toBe("event");
    if (result.status !== "event") return;
    expect(result.event.source.chatType).toBe("sms");
  });

  it("reports a delivery with no sender rather than inventing one", () => {
    const raw = photonDelivery({ sender: {} });
    expect(read("imessage", raw, PHOTON).status).toBe("invalid");
  });
});
