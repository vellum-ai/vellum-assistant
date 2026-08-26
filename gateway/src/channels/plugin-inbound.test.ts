import { describe, expect, it } from "bun:test";

import { IngressInboundSchema } from "./ingress-inbound.js";
import {
  pluginMemberIdentity,
  readPluginInbound,
  unscopedPluginId,
} from "./plugin-inbound.js";

const RECEIVED_AT = "2026-02-01T00:00:00.000Z";

function declare(raw: unknown = {}) {
  return IngressInboundSchema.parse(raw);
}

/** A reply in the shape the plugin SDK's contract produces. */
function reply(overrides: Record<string, unknown> = {}) {
  return {
    version: "v1",
    sourceChannel: "imessage",
    message: {
      content: "hello",
      conversationExternalId: "chat-1",
      externalMessageId: "msg-1",
    },
    actor: { actorExternalId: "+12025550142", displayName: "Ada" },
    source: { updateId: "msg-1", chatType: "dm" },
    ...overrides,
  };
}

function read(body: unknown, inbound = declare()) {
  return readPluginInbound({
    plugin: "imessage",
    inbound,
    body,
    receivedAt: RECEIVED_AT,
  });
}

describe("readPluginInbound", () => {
  it("reads a canonical reply into an event", () => {
    const result = read(reply());

    expect(result.status).toBe("event");
    if (result.status !== "event") return;
    expect(result.event.message.content).toBe("hello");
    expect(result.event.receivedAt).toBe(RECEIVED_AT);
    expect(result.event.source.chatType).toBe("dm");
    expect(result.event.actor.displayName).toBe("Ada");
  });

  it("stamps the channel rather than reading the one the reply claims", () => {
    // A plugin that could name its own channel could claim `slack` and inherit
    // Slack's admission floor, its contact records, and trust the guardian
    // granted a different surface entirely.
    const result = read(reply({ sourceChannel: "slack" }));

    expect(result.status).toBe("event");
    if (result.status !== "event") return;
    expect(result.event.sourceChannel).toBe("plugin");
  });

  it("scopes every external id to the plugin that produced it", () => {
    // One channel id covers every installed plugin. Without the prefix, two
    // plugins whose vendors both address by phone number would share
    // conversations and contact records, and either could address the other's.
    const result = read(reply());

    expect(result.status).toBe("event");
    if (result.status !== "event") return;
    expect(result.event.message.conversationExternalId).toBe("imessage:chat-1");
    expect(result.event.actor.actorExternalId).toBe("imessage:+12025550142");
    expect(result.event.message.externalMessageId).toBe("imessage:msg-1");
  });

  it("maps a scoped plugin actor onto the plugin's own contact channel", () => {
    expect(
      pluginMemberIdentity("plugin", "imessage:+12025550142"),
    ).toEqual({ type: "imessage", address: "+12025550142" });
    expect(pluginMemberIdentity("plugin", "meeting-bot:room-42")).toEqual({
      type: "meeting-bot",
      address: "room-42",
    });
    expect(pluginMemberIdentity("phone", "+12025550142")).toEqual({
      type: "phone",
      address: "+12025550142",
    });
  });

  it("returns the vendor id from a scoped plugin id", () => {
    // The plugin send API addresses chats the way the vendor does. A notice
    // that kept the prefix would aim at a chat that does not exist.
    expect(unscopedPluginId("imessage", "imessage:chat-1")).toBe("chat-1");
    expect(unscopedPluginId("imessage", "imessage:+12025550142")).toBe(
      "+12025550142",
    );
    expect(unscopedPluginId("imessage", "chat-1")).toBe("chat-1");
  });

  it("takes the plugin name from the caller, not the reply", () => {
    // The caller has it from the request path, which is the only place it can
    // come from without letting a manifest spell another plugin's namespace.
    const result = readPluginInbound({
      plugin: "signal",
      inbound: declare(),
      body: reply({ plugin: "imessage" }),
      receivedAt: RECEIVED_AT,
    });

    expect(result.status).toBe("event");
    if (result.status !== "event") return;
    expect(result.event.actor.actorExternalId).toBe("signal:+12025550142");
  });

  it("canonicalizes a declared phone identity before scoping it", () => {
    // Two spellings of a number are one person only if the declaration says
    // the addresses are phone numbers, and the prefix has to land on the form
    // everything downstream compares on.
    const result = read(
      reply({
        actor: { actorExternalId: "(202) 555-0142" },
      }),
      declare({ identity: "phone" }),
    );

    expect(result.status).toBe("event");
    if (result.status !== "event") return;
    expect(result.event.actor.actorExternalId).toBe("imessage:+12025550142");
  });

  it("leaves an opaque identity alone", () => {
    // Rewriting an id that was already canonical is how a returning sender
    // stops matching their own contact record.
    const result = read(reply({ actor: { actorExternalId: "U012ABC" } }));

    expect(result.status).toBe("event");
    if (result.status !== "event") return;
    expect(result.event.actor.actorExternalId).toBe("imessage:U012ABC");
  });

  it("reads a reply through the manifest's field mapping", () => {
    // A plugin that would rather hand back its own structure can, without the
    // gateway learning a vendor format.
    const result = read(
      {
        chat: { guid: "iMessage;-;+12025550188" },
        text: "hi there",
        id: "p_9",
        sender: { handle: "+12025550188", name: "Grace" },
      },
      declare({
        identity: "phone",
        fields: {
          content: "text",
          conversationExternalId: "chat.guid",
          externalMessageId: "id",
          actorExternalId: "sender.handle",
          actorDisplayName: "sender.name",
        },
      }),
    );

    expect(result.status).toBe("event");
    if (result.status !== "event") return;
    expect(result.event.message.content).toBe("hi there");
    expect(result.event.message.conversationExternalId).toBe(
      "imessage:iMessage;-;+12025550188",
    );
    expect(result.event.actor.displayName).toBe("Grace");
  });

  it("treats an acknowledgement as no message at all", () => {
    // The ordinary case. Delivery receipts, outbound echoes, and events the
    // plugin does not handle all reply like this.
    expect(read({ ok: true }).status).toBe("none");
    expect(read({ ok: true, ignored: "not an inbound message" }).status).toBe(
      "none",
    );
    expect(read(undefined).status).toBe("none");
    expect(read("").status).toBe("none");
  });

  it("reports a reply that carries some of a message but not enough", () => {
    // Dropping this quietly would present a plugin bug as a vendor that
    // stopped delivering.
    const result = read({
      message: { content: "hello", conversationExternalId: "chat-1" },
    });

    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") return;
    expect(result.reason).toContain("actorExternalId");
    expect(result.reason).toContain("externalMessageId");
  });

  it("accepts a message with no text", () => {
    // An attachment-only message is a real message. Content is the one
    // required-looking field that is not required.
    const result = read(
      reply({
        message: {
          content: "",
          conversationExternalId: "chat-1",
          externalMessageId: "msg-1",
        },
      }),
    );

    expect(result.status).toBe("event");
    if (result.status !== "event") return;
    expect(result.event.message.content).toBe("");
  });

  it("treats a whitespace-only identity as absent", () => {
    // It canonicalizes to nothing, so admitting it would build an event whose
    // sender is the plugin prefix and nobody else.
    const result = read(reply({ actor: { actorExternalId: "   " } }));

    expect(result.status).toBe("invalid");
  });

  it("carries the vendor payload the plugin kept", () => {
    // The gateway understands only the declared fields, so anything the vendor
    // sent beyond them survives on `raw` or nowhere.
    const result = read(reply({ raw: { reactions: ["heart"] } }));

    expect(result.status).toBe("event");
    if (result.status !== "event") {
      return;
    }
    expect(result.event.raw).toEqual({ reactions: ["heart"] });
  });

  it("carries nothing as raw when the plugin kept nothing", () => {
    // `raw` means the vendor's payload. Substituting the reply envelope when
    // the plugin sent none would quietly redefine it.
    for (const body of [
      reply(),
      reply({ raw: "not an object" }),
      reply({ raw: ["not an object either"] }),
      reply({ raw: null }),
    ]) {
      const result = read(body);
      expect(result.status).toBe("event");
      if (result.status !== "event") {
        continue;
      }
      expect(result.event.raw).toEqual({});
    }
  });
});
