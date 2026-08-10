import { describe, expect, it } from "bun:test";

import {
  INBOUND_FIELD_DEFAULTS,
  IngressInboundSchema,
  canonicalInbound,
  inboundFieldSource,
  readFieldSource,
  readInboundField,
} from "./ingress-inbound.js";

/** Parse a declaration the way the manifest reader would. */
function declare(raw: unknown) {
  return IngressInboundSchema.parse(raw);
}

describe("IngressInboundSchema", () => {
  it("takes an empty declaration for a plugin already replying in shape", () => {
    // The whole point of the defaults: a plugin returning what the SDK's
    // contract says it returns should not have to restate the contract.
    const inbound = declare({});

    expect(inbound.identity).toBe("opaque");
    expect(inboundFieldSource(inbound, "content")).toBe("message.content");
    expect(inboundFieldSource(inbound, "actorExternalId")).toBe(
      "actor.actorExternalId",
    );
  });

  it("keeps the defaults for fields an override did not name", () => {
    const inbound = declare({ fields: { content: "text" } });

    expect(inboundFieldSource(inbound, "content")).toBe("text");
    expect(inboundFieldSource(inbound, "conversationExternalId")).toBe(
      INBOUND_FIELD_DEFAULTS.conversationExternalId,
    );
  });

  it("rejects a field name it does not know", () => {
    // Silently ignoring one would present a typo as a plugin that stopped
    // sending the field.
    expect(() => declare({ fields: { contnet: "text" } })).toThrow();
  });

  it("rejects a path that is not dotted identifiers", () => {
    // The manifest is untrusted input read against an attacker-authored
    // document, so anything resembling an expression language is refused.
    for (const path of [
      "message[0].content",
      "message.*.content",
      "$.message.content",
      "message..content",
      ".content",
      "content.",
      "message/content",
    ]) {
      expect(() => declare({ fields: { content: path } })).toThrow();
    }
  });

  it("refuses a path through __proto__", () => {
    expect(() =>
      declare({ fields: { content: "__proto__.content" } }),
    ).toThrow();
  });

  it("rejects an identity kind it cannot canonicalize", () => {
    expect(() => declare({ identity: "snowflake" })).toThrow();
  });
});

describe("canonicalInbound", () => {
  it("encodes a spelled-out default the same as an omitted one", () => {
    // Two manifests that read the same fields the same way are the same
    // grant. Without this, spelling out a default would revoke an approval.
    const implicit = declare({});
    const explicit = declare({
      identity: "opaque",
      fields: { ...INBOUND_FIELD_DEFAULTS },
    });

    expect(canonicalInbound(explicit)).toBe(canonicalInbound(implicit));
  });

  it("changes when a field is read from somewhere else", () => {
    // Reading the sender from a different key is a different message, which
    // is a change to what the guardian approved.
    expect(
      canonicalInbound(declare({ fields: { actorExternalId: "from" } })),
    ).not.toBe(canonicalInbound(declare({})));
  });

  it("ignores the order keys were typed in, however deep", () => {
    // A declaration that reads every field from the same place is the same
    // grant. Digesting it differently drops an approved declaration back to
    // pending and stops serving it until a guardian approves the identical
    // thing again.
    const a = declare({
      fields: {
        chatType: { from: "p", map: { a: "1", b: "2" }, default: "d" },
      },
    });
    const b = declare({
      fields: {
        chatType: { default: "d", map: { b: "2", a: "1" }, from: "p" },
      },
    });

    expect(canonicalInbound(a)).toBe(canonicalInbound(b));
  });

  it("changes when the identity kind changes", () => {
    // `phone` decides that two spellings of a number are one person, so it
    // decides which stored contact a sender matches.
    expect(canonicalInbound(declare({ identity: "phone" }))).not.toBe(
      canonicalInbound(declare({})),
    );
  });
});

describe("value maps", () => {
  it("matches a key spelled the vendor\'s way", () => {
    // A declaration should be able to quote what the wire says. Photon sends
    // `iMessage`, and a lookup that folded only the payload would miss the key
    // and fall through to the conservative default, silently treating every
    // blue bubble as the spoofable-sender case.
    const inbound = declare({
      fields: {
        chatType: {
          from: "platform",
          map: { iMessage: "imessage" },
          default: "sms",
        },
      },
    });

    expect(
      readFieldSource(
        { platform: "iMessage" },
        inboundFieldSource(inbound, "chatType"),
      ),
    ).toBe("imessage");
  });

  it("takes the default for a value no key matches", () => {
    const inbound = declare({
      fields: {
        chatType: {
          from: "platform",
          map: { imessage: "imessage" },
          default: "sms",
        },
      },
    });

    expect(
      readFieldSource(
        { platform: "RCS" },
        inboundFieldSource(inbound, "chatType"),
      ),
    ).toBe("sms");
    expect(readFieldSource({}, inboundFieldSource(inbound, "chatType"))).toBe(
      "sms",
    );
  });

  it("tries each path in turn and takes the first with a value", () => {
    const inbound = declare({
      fields: { conversationExternalId: ["message.space.id", "space.id"] },
    });
    const source = inboundFieldSource(inbound, "conversationExternalId");

    expect(readFieldSource({ space: { id: "outer" } }, source)).toBe("outer");
    expect(
      readFieldSource(
        { message: { space: { id: "inner" } }, space: { id: "outer" } },
        source,
      ),
    ).toBe("inner");
  });
});

describe("readInboundField", () => {
  const body = {
    message: { content: "hi", conversationExternalId: "chat-1", count: 3 },
    actor: { actorExternalId: "+12025550142", displayName: null },
    empty: {},
  };

  it("reads a nested string", () => {
    expect(readInboundField(body, "message.content")).toBe("hi");
  });

  it("returns undefined for anything that is not a string", () => {
    // "absent" and "present but the wrong type" have to be one answer, so a
    // malformed reply cannot half-build an event.
    expect(readInboundField(body, "message.count")).toBeUndefined();
    expect(readInboundField(body, "actor.displayName")).toBeUndefined();
    expect(readInboundField(body, "message")).toBeUndefined();
  });

  it("returns undefined for a path that does not exist", () => {
    expect(readInboundField(body, "message.missing")).toBeUndefined();
    expect(readInboundField(body, "missing.content")).toBeUndefined();
    expect(readInboundField(body, "empty.a.b")).toBeUndefined();
  });

  it("reads nothing off a non-object body", () => {
    expect(readInboundField(null, "message.content")).toBeUndefined();
    expect(readInboundField("hi", "message.content")).toBeUndefined();
    expect(readInboundField(undefined, "message.content")).toBeUndefined();
  });

  it("does not walk into inherited properties", () => {
    // A reply is a parsed JSON document, but the reader is what stands between
    // a declared path and the prototype chain, so it checks ownership itself.
    expect(readInboundField({}, "constructor.name")).toBeUndefined();
    expect(readInboundField({}, "toString")).toBeUndefined();
  });
});
