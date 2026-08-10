import { describe, expect, it } from "bun:test";

import {
  INBOUND_FIELD_DEFAULTS,
  IngressInboundSchema,
  canonicalInbound,
  inboundFieldPath,
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
    expect(inboundFieldPath(inbound, "content")).toBe("message.content");
    expect(inboundFieldPath(inbound, "actorExternalId")).toBe(
      "actor.actorExternalId",
    );
  });

  it("keeps the defaults for fields an override did not name", () => {
    const inbound = declare({ fields: { content: "text" } });

    expect(inboundFieldPath(inbound, "content")).toBe("text");
    expect(inboundFieldPath(inbound, "conversationExternalId")).toBe(
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

  it("changes when the identity kind changes", () => {
    // `phone` decides that two spellings of a number are one person, so it
    // decides which stored contact a sender matches.
    expect(canonicalInbound(declare({ identity: "phone" }))).not.toBe(
      canonicalInbound(declare({})),
    );
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
