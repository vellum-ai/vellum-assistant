/**
 * The kind derivation is the single reader of the field encodings, so its
 * matrix is the compatibility contract: every shape an unstamped replayed
 * retry payload can carry must classify exactly as the consumers that read
 * those fields directly would classify it.
 */
import { describe, expect, test } from "bun:test";

import {
  inboundEventRefersToAnotherMessage,
  resolveInboundEventKind,
  resolveInboundReactionPayload,
} from "../inbound-event-kind.js";
import { RuntimeInboundPayloadSchema } from "../inbound-contract.js";

describe("resolveInboundEventKind", () => {
  test("a stamped kind wins over every legacy field", () => {
    expect(
      resolveInboundEventKind({
        eventKind: "edit",
        callbackData: "message_deleted",
      }),
    ).toBe("edit");
  });

  test("an unrecognized stamp falls back to legacy derivation", () => {
    expect(
      resolveInboundEventKind({ eventKind: "future-kind", isEdit: true }),
    ).toBe("edit");
  });

  test("legacy isEdit classifies as edit", () => {
    expect(resolveInboundEventKind({ isEdit: true })).toBe("edit");
  });

  test("the delete sentinel classifies as delete", () => {
    expect(resolveInboundEventKind({ callbackData: "message_deleted" })).toBe(
      "delete",
    );
  });

  test("reaction prefixes classify as reaction, both directions", () => {
    expect(resolveInboundEventKind({ callbackData: "reaction:+1" })).toBe(
      "reaction",
    );
    expect(
      resolveInboundEventKind({ callbackData: "reaction_removed:+1" }),
    ).toBe("reaction");
  });

  test("any other callbackData classifies as button", () => {
    expect(
      resolveInboundEventKind({ callbackData: "apr:req-1:approve_once" }),
    ).toBe("button");
    expect(resolveInboundEventKind({ callbackData: "some-action-id" })).toBe(
      "button",
    );
  });

  test("an empty callbackData is not a family", () => {
    // Mirrors the old hasCallbackData predicate, which required length > 0.
    expect(resolveInboundEventKind({ callbackData: "" })).toBe("message");
  });

  test("callbackQueryId alone classifies as button", () => {
    expect(resolveInboundEventKind({ callbackQueryId: "cbq-1" })).toBe(
      "button",
    );
  });

  test("nothing stated is a plain message", () => {
    expect(resolveInboundEventKind({})).toBe("message");
  });
});

describe("inboundEventRefersToAnotherMessage", () => {
  test("only a plain message stands alone", () => {
    expect(inboundEventRefersToAnotherMessage("message")).toBe(false);
    expect(inboundEventRefersToAnotherMessage("edit")).toBe(true);
    expect(inboundEventRefersToAnotherMessage("delete")).toBe(true);
    expect(inboundEventRefersToAnotherMessage("reaction")).toBe(true);
    expect(inboundEventRefersToAnotherMessage("button")).toBe(true);
  });
});

describe("resolveInboundReactionPayload", () => {
  test("a structured payload wins outright, typed fields included", () => {
    expect(
      resolveInboundReactionPayload({
        eventKind: "reaction",
        reaction: {
          op: "removed",
          emoji: "+1",
          emojiKind: "shortcode",
          emojiName: "+1",
          targetMessageId: "11.22",
        },
        callbackData: "reaction:eyes",
      }),
    ).toEqual({
      op: "removed",
      emoji: "+1",
      emojiKind: "shortcode",
      emojiName: "+1",
      targetMessageId: "11.22",
    });
  });

  test("a stored payload without typed fields recovers its kind", () => {
    // Rows predating the typed fields carry the spelling only. This is the
    // one place the kind is inferred, and each spelling has one answer.
    const at = (emoji: string) =>
      resolveInboundReactionPayload({
        eventKind: "reaction",
        reaction: { op: "added", emoji, targetMessageId: "11.22" },
      });
    expect(at("<:blob_wave:987>")).toMatchObject({
      emojiKind: "custom",
      emojiName: "blob_wave",
      emojiId: "987",
    });
    // The plain form records nothing about animation, so the field is
    // absent rather than a fabricated false; a resolver must not read
    // "not animated" off a row that never knew.
    expect(at("<:blob_wave:987>")).not.toHaveProperty("emojiAnimated");
    expect(at("<a:party:5>")).toMatchObject({
      emojiKind: "custom",
      emojiName: "party",
      emojiId: "5",
      emojiAnimated: true,
    });
    expect(at("thumbsup")).toMatchObject({
      emojiKind: "shortcode",
      emojiName: "thumbsup",
    });
    expect(at("🎉")).toMatchObject({ emojiKind: "unicode", emojiName: "🎉" });
    // The spelling itself is never rewritten: the write path parses it back.
    expect(at("<:blob_wave:987>")?.emoji).toBe("<:blob_wave:987>");
  });

  test("a replayed payload parses its sentinel and wire target", () => {
    expect(
      resolveInboundReactionPayload({
        callbackData: "reaction:thumbsup",
        sourceMetadata: { messageId: "33.44" },
      }),
    ).toEqual({
      op: "added",
      emoji: "thumbsup",
      emojiKind: "shortcode",
      emojiName: "thumbsup",
      targetMessageId: "33.44",
    });
    expect(
      resolveInboundReactionPayload({
        callbackData: "reaction_removed:thumbsup",
        sourceMetadata: { messageId: "33.44" },
      }),
    ).toEqual({
      op: "removed",
      emoji: "thumbsup",
      emojiKind: "shortcode",
      emojiName: "thumbsup",
      targetMessageId: "33.44",
    });
  });

  test("no emoji or no target is not a reaction payload", () => {
    expect(
      resolveInboundReactionPayload({
        callbackData: "reaction:",
        sourceMetadata: { messageId: "33.44" },
      }),
    ).toBeNull();
    expect(
      resolveInboundReactionPayload({ callbackData: "reaction:thumbsup" }),
    ).toBeNull();
    expect(
      resolveInboundReactionPayload({
        callbackData: "apr:req-1:approve_once",
        sourceMetadata: { messageId: "33.44" },
      }),
    ).toBeNull();
  });
});

describe("RuntimeInboundPayloadSchema carries a reaction's typed emoji", () => {
  const base = {
    sourceChannel: "discord",
    interface: "discord",
    conversationExternalId: "chan-1",
    externalMessageId: "msg-1:reaction:<:party_blob:111>:user-1:ingest-1",
    content: "",
    eventKind: "reaction",
    actorExternalId: "user-1",
  };

  test("a custom emoji keeps all four typed fields through the wire schema", () => {
    const parsed = RuntimeInboundPayloadSchema.parse({
      ...base,
      reaction: {
        op: "added",
        emoji: "<:party_blob:111>",
        emojiKind: "custom",
        emojiName: "party_blob",
        emojiId: "111",
        emojiAnimated: true,
        targetMessageId: "msg-1",
      },
    });
    expect(parsed.reaction).toEqual({
      op: "added",
      emoji: "<:party_blob:111>",
      emojiKind: "custom",
      emojiName: "party_blob",
      emojiId: "111",
      emojiAnimated: true,
      targetMessageId: "msg-1",
    });
  });

  test("a reaction carrying only the spelling still parses", () => {
    const parsed = RuntimeInboundPayloadSchema.parse({
      ...base,
      reaction: { op: "removed", emoji: "+1", targetMessageId: "msg-1" },
    });
    expect(parsed.reaction).toEqual({
      op: "removed",
      emoji: "+1",
      targetMessageId: "msg-1",
    });
  });
});
