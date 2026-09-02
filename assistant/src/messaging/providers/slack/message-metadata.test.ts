import { describe, expect, test } from "bun:test";

import {
  buildSlackTimezoneMetadata,
  formatSlackTimezoneLabel,
  mergeSlackMetadata,
  providerMetadataOfPreSendSlackEnvelope,
  readSlackMetadata,
  readSlackMetadataFromMessageMetadata,
  type SlackMessageMetadata,
  slackViewOfProviderMetadata,
  writeSlackMetadata,
} from "./message-metadata.js";

describe("formatSlackTimezoneLabel", () => {
  test("uses compact common labels for IANA timezones", () => {
    expect(formatSlackTimezoneLabel("America/Denver")).toBe("MT");
    expect(formatSlackTimezoneLabel("America/New_York")).toBe("ET");
  });

  test("compacts persisted Slack profile labels before falling back to timezone", () => {
    expect(
      formatSlackTimezoneLabel("America/New_York", {
        persistedLabel: "Eastern Time",
      }),
    ).toBe("ET");
  });
});

describe("buildSlackTimezoneMetadata", () => {
  test("copies only populated Slack timezone fields", () => {
    expect(
      buildSlackTimezoneMetadata({
        actorTimezone: " America/New_York ",
        actorTimezoneLabel: " ET ",
        actorTimezoneOffsetSeconds: -18_000,
        timestampTimezone: "America/New_York",
        timestampTimezoneLabel: "",
        speakerTimezoneLabel: " Eastern Time ",
      }),
    ).toEqual({
      actorTimezone: "America/New_York",
      actorTimezoneLabel: "ET",
      actorTimezoneOffsetSeconds: -18_000,
      timestampTimezone: "America/New_York",
      speakerTimezoneLabel: "Eastern Time",
    });
  });
});

describe("readSlackMetadata", () => {
  test("tolerates null and undefined", () => {
    expect(readSlackMetadata(null)).toBeNull();
    expect(readSlackMetadata(undefined)).toBeNull();
  });

  test("returns null on JSON parse error", () => {
    expect(readSlackMetadata("not-json")).toBeNull();
    expect(readSlackMetadata("{")).toBeNull();
  });

  test("returns null when the payload is not an object", () => {
    expect(readSlackMetadata(JSON.stringify("string"))).toBeNull();
    expect(readSlackMetadata(JSON.stringify(42))).toBeNull();
    expect(readSlackMetadata(JSON.stringify(null))).toBeNull();
    expect(readSlackMetadata(JSON.stringify([{ source: "slack" }]))).toBeNull();
  });

  test("rejects metadata whose source is not slack", () => {
    const raw = JSON.stringify({
      source: "telegram",
      channelId: "C123",
      channelTs: "1700000000.000100",
      eventKind: "message",
    });
    expect(readSlackMetadata(raw)).toBeNull();
  });

  test("rejects payloads with malformed optional fields", () => {
    const badThreadTs = JSON.stringify({
      source: "slack",
      channelId: "C123",
      channelTs: "1700000000.000100",
      eventKind: "message",
      threadTs: 42, // should be string
    });
    const badReactionOp = JSON.stringify({
      source: "slack",
      channelId: "C123",
      channelTs: "1700000000.000100",
      eventKind: "reaction",
      reaction: {
        emoji: "thumbsup",
        targetChannelTs: "1700000000.000100",
        op: "bogus",
      },
    });
    const badEditedAt = JSON.stringify({
      source: "slack",
      channelId: "C123",
      channelTs: "1700000000.000100",
      eventKind: "message",
      editedAt: "not-a-number",
    });
    const badChannelName = JSON.stringify({
      source: "slack",
      channelId: "C123",
      channelName: 42,
      channelTs: "1700000000.000100",
      eventKind: "message",
    });
    expect(readSlackMetadata(badThreadTs)).toBeNull();
    expect(readSlackMetadata(badReactionOp)).toBeNull();
    expect(readSlackMetadata(badEditedAt)).toBeNull();
    expect(readSlackMetadata(badChannelName)).toBeNull();
  });

  test("strips unknown top-level keys from the returned object", () => {
    const raw = JSON.stringify({
      source: "slack",
      channelId: "C123",
      channelTs: "1700000000.000100",
      eventKind: "message",
      userMessageChannel: "channel:abc",
      provenanceTrustClass: "trusted_contact",
    });
    const parsed = readSlackMetadata(raw);
    expect(parsed).toEqual({
      source: "slack",
      channelId: "C123",
      channelTs: "1700000000.000100",
      eventKind: "message",
    });
  });

  test("rejects payloads missing required fields", () => {
    const noChannelId = JSON.stringify({
      source: "slack",
      channelTs: "1700000000.000100",
      eventKind: "message",
    });
    const noChannelTs = JSON.stringify({
      source: "slack",
      channelId: "C123",
      eventKind: "message",
    });
    const badEventKind = JSON.stringify({
      source: "slack",
      channelId: "C123",
      channelTs: "1700000000.000100",
      eventKind: "totally-bogus",
    });
    expect(readSlackMetadata(noChannelId)).toBeNull();
    expect(readSlackMetadata(noChannelTs)).toBeNull();
    expect(readSlackMetadata(badEventKind)).toBeNull();
  });

  test("parses a fully populated message metadata payload", () => {
    const meta: SlackMessageMetadata = {
      source: "slack",
      channelId: "C123",
      channelName: "engineering",
      channelTs: "1700000000.000100",
      threadTs: "1699999999.000000",
      displayName: "Alice",
      actorExternalUserId: "U_ALICE",
      eventKind: "message",
      editedAt: 1700000123,
    };
    const parsed = readSlackMetadata(JSON.stringify(meta));
    expect(parsed).toEqual(meta);
  });

  test("parses a reaction metadata payload", () => {
    const meta: SlackMessageMetadata = {
      source: "slack",
      channelId: "C123",
      channelTs: "1700000050.000200",
      eventKind: "reaction",
      reaction: {
        emoji: "thumbsup",
        actorDisplayName: "Bob",
        targetChannelTs: "1700000000.000100",
        op: "added",
      },
    };
    const parsed = readSlackMetadata(JSON.stringify(meta));
    expect(parsed).toEqual(meta);
  });
});

describe("readSlackMetadataFromMessageMetadata", () => {
  const meta: SlackMessageMetadata = {
    source: "slack",
    channelId: "C123",
    channelTs: "1700000000.000100",
    threadTs: "1699999999.000000",
    eventKind: "message",
  };

  test("reads nested slackMeta from a message metadata envelope", () => {
    expect(
      readSlackMetadataFromMessageMetadata(
        JSON.stringify({
          userMessageChannel: "slack",
          slackMeta: writeSlackMetadata(meta),
        }),
      ),
    ).toEqual(meta);
  });

  test("can read flat legacy Slack metadata when explicitly allowed", () => {
    const raw = writeSlackMetadata(meta);
    expect(readSlackMetadataFromMessageMetadata(raw)).toBeNull();
    expect(
      readSlackMetadataFromMessageMetadata(raw, { allowFlatLegacy: true }),
    ).toEqual(meta);
  });
});

describe("writeSlackMetadata", () => {
  test("round-trips through readSlackMetadata", () => {
    const meta: SlackMessageMetadata = {
      source: "slack",
      channelId: "C123",
      channelName: "engineering",
      channelTs: "1700000000.000100",
      threadTs: "1699999999.000000",
      displayName: "Alice",
      actorExternalUserId: "U_ALICE",
      eventKind: "message",
    };
    const raw = writeSlackMetadata(meta);
    expect(typeof raw).toBe("string");
    expect(readSlackMetadata(raw)).toEqual(meta);
  });

  test("round-trips reaction metadata", () => {
    const meta: SlackMessageMetadata = {
      source: "slack",
      channelId: "C123",
      channelTs: "1700000050.000200",
      eventKind: "reaction",
      reaction: {
        emoji: "eyes",
        targetChannelTs: "1700000000.000100",
        op: "removed",
      },
    };
    const raw = writeSlackMetadata(meta);
    expect(readSlackMetadata(raw)).toEqual(meta);
  });
});

describe("mergeSlackMetadata", () => {
  const baseMeta: SlackMessageMetadata = {
    source: "slack",
    channelId: "C123",
    channelTs: "1700000000.000100",
    threadTs: "1699999999.000000",
    displayName: "Alice",
    eventKind: "message",
  };

  test("preserves unrelated existing fields", () => {
    const existing = writeSlackMetadata(baseMeta);
    const merged = mergeSlackMetadata(existing, { editedAt: 1700000123 });
    const parsed = readSlackMetadata(merged);
    expect(parsed).toEqual({ ...baseMeta, editedAt: 1700000123 });
  });

  test("overrides fields present in both existing and patch", () => {
    const existing = writeSlackMetadata(baseMeta);
    const merged = mergeSlackMetadata(existing, { displayName: "Alicia" });
    const parsed = readSlackMetadata(merged);
    expect(parsed?.displayName).toBe("Alicia");
    expect(parsed?.channelId).toBe(baseMeta.channelId);
  });

  test("ignores undefined patch fields rather than wiping existing values", () => {
    const existing = writeSlackMetadata(baseMeta);
    const merged = mergeSlackMetadata(existing, { displayName: undefined });
    const parsed = readSlackMetadata(merged);
    expect(parsed?.displayName).toBe(baseMeta.displayName);
  });

  test("supports marking a message deleted while keeping prior fields", () => {
    const existing = writeSlackMetadata(baseMeta);
    const merged = mergeSlackMetadata(existing, { deletedAt: 1700000200 });
    const parsed = readSlackMetadata(merged);
    expect(parsed).toEqual({ ...baseMeta, deletedAt: 1700000200 });
  });

  test("constructs valid metadata when existing is null and patch supplies required fields", () => {
    const merged = mergeSlackMetadata(null, {
      source: "slack",
      channelId: "C999",
      channelTs: "1700000300.000400",
      eventKind: "message",
      displayName: "Carol",
    });
    expect(readSlackMetadata(merged)).toEqual({
      source: "slack",
      channelId: "C999",
      channelTs: "1700000300.000400",
      eventKind: "message",
      displayName: "Carol",
    });
  });

  test("constructs valid metadata when existing fails to parse as slack", () => {
    const merged = mergeSlackMetadata("garbage", {
      source: "slack",
      channelId: "C111",
      channelTs: "1700000400.000500",
      eventKind: "message",
    });
    expect(readSlackMetadata(merged)).toEqual({
      source: "slack",
      channelId: "C111",
      channelTs: "1700000400.000500",
      eventKind: "message",
    });
  });

  test("forces source to slack even if patch attempts to override it", () => {
    const existing = writeSlackMetadata(baseMeta);
    const merged = mergeSlackMetadata(existing, {
      // @ts-expect-error - intentional bad input to verify the guard
      source: "telegram",
      displayName: "Mallory",
    });
    const parsed = readSlackMetadata(merged);
    expect(parsed?.source).toBe("slack");
    expect(parsed?.displayName).toBe("Mallory");
  });

  test("preserves unrelated non-slack top-level keys from the existing blob", () => {
    const existing = JSON.stringify({
      userMessageChannel: "channel:abc",
      provenanceTrustClass: "trusted_contact",
      forkSourceMessageId: "msg-parent-1",
    });
    const merged = mergeSlackMetadata(existing, {
      source: "slack",
      channelId: "C123",
      channelTs: "1700000000.000100",
      eventKind: "message",
    });
    const rawParsed = JSON.parse(merged) as Record<string, unknown>;
    expect(rawParsed.userMessageChannel).toBe("channel:abc");
    expect(rawParsed.provenanceTrustClass).toBe("trusted_contact");
    expect(rawParsed.forkSourceMessageId).toBe("msg-parent-1");
    expect(rawParsed.source).toBe("slack");
    expect(rawParsed.channelId).toBe("C123");
    expect(readSlackMetadata(merged)).toEqual({
      source: "slack",
      channelId: "C123",
      channelTs: "1700000000.000100",
      eventKind: "message",
    });
  });

  test("preserves non-slack keys when patching an already-slack-tagged blob", () => {
    const existing = JSON.stringify({
      ...baseMeta,
      userMessageChannel: "channel:abc",
    });
    const merged = mergeSlackMetadata(existing, { editedAt: 1700000999 });
    const rawParsed = JSON.parse(merged) as Record<string, unknown>;
    expect(rawParsed.userMessageChannel).toBe("channel:abc");
    expect(readSlackMetadata(merged)).toEqual({
      ...baseMeta,
      editedAt: 1700000999,
    });
  });

  test("preserves nested reaction metadata across a patch", () => {
    const reactionMeta: SlackMessageMetadata = {
      source: "slack",
      channelId: "C123",
      channelTs: "1700000050.000200",
      eventKind: "reaction",
      reaction: {
        emoji: "thumbsup",
        targetChannelTs: "1700000000.000100",
        op: "added",
      },
    };
    const existing = writeSlackMetadata(reactionMeta);
    const merged = mergeSlackMetadata(existing, {
      displayName: "Bob",
    });
    const parsed = readSlackMetadata(merged);
    expect(parsed?.reaction).toEqual(reactionMeta.reaction);
    expect(parsed?.displayName).toBe("Bob");
  });
});

describe("providerMetadataOfPreSendSlackEnvelope", () => {
  test("reads a pre-send Slack envelope as the neutral shape, Slack's own fields riding along", () => {
    expect(
      providerMetadataOfPreSendSlackEnvelope({
        slackMeta: JSON.stringify({
          source: "slack",
          eventKind: "message",
          channelId: "C1",
          threadTs: "1700000000.000001",
          timestampTimezone: "America/New_York",
        }),
      }),
    ).toEqual({
      source: "slack",
      conversationExternalId: "C1",
      eventKind: "message",
      threadId: "1700000000.000001",
      timestampTimezone: "America/New_York",
    });
  });

  test("reads as null for a reconciled row, a non-Slack envelope, and a row without slackMeta", () => {
    expect(
      providerMetadataOfPreSendSlackEnvelope({
        slackMeta: JSON.stringify({
          source: "slack",
          eventKind: "message",
          channelId: "C1",
          channelTs: "1700000000.000002",
        }),
      }),
    ).toBeNull();
    expect(
      providerMetadataOfPreSendSlackEnvelope({
        slackMeta: JSON.stringify({ source: "telegram", channelId: "C1" }),
      }),
    ).toBeNull();
    expect(providerMetadataOfPreSendSlackEnvelope({})).toBeNull();
  });
});

describe("slackViewOfProviderMetadata", () => {
  test("maps a Slack reply row's neutral envelope onto the Slack view, extras included", () => {
    const view = slackViewOfProviderMetadata({
      source: "slack",
      conversationExternalId: "C123",
      messageId: "1700000000.000100",
      threadId: "1700000000.000001",
      eventKind: "message",
      timestampTimezone: "America/New_York",
      timestampTimezoneLabel: "ET",
      slackFiles: [{ name: "report.pdf", mimetype: "application/pdf" }],
      deletedAt: 1700000001000,
    });
    expect(view).toEqual({
      source: "slack",
      channelId: "C123",
      channelTs: "1700000000.000100",
      threadTs: "1700000000.000001",
      eventKind: "message",
      timestampTimezone: "America/New_York",
      timestampTimezoneLabel: "ET",
      slackFiles: [{ name: "report.pdf", mimetype: "application/pdf" }],
      deletedAt: 1700000001000,
    });
  });

  test("a reaction row's view stores the reacted message's ts as channelTs", () => {
    const view = slackViewOfProviderMetadata({
      source: "slack",
      conversationExternalId: "C123",
      eventKind: "reaction",
      actorExternalId: "U1",
      displayName: "Alice",
      reaction: {
        targetMessageId: "1700000000.000100",
        emoji: "tada",
        op: "added",
        actorDisplayName: "Alice",
      },
    });
    expect(view).toEqual({
      source: "slack",
      channelId: "C123",
      channelTs: "1700000000.000100",
      actorExternalUserId: "U1",
      displayName: "Alice",
      eventKind: "reaction",
      reaction: {
        emoji: "tada",
        op: "added",
        targetChannelTs: "1700000000.000100",
        actorDisplayName: "Alice",
      },
    });
  });

  test("a row naming no post yet, or another channel's row, has no Slack view", () => {
    expect(
      slackViewOfProviderMetadata({
        source: "slack",
        conversationExternalId: "C123",
        eventKind: "message",
      }),
    ).toBeNull();
    expect(
      slackViewOfProviderMetadata({
        source: "discord",
        conversationExternalId: "999",
        messageId: "1",
        eventKind: "message",
      }),
    ).toBeNull();
  });

  test("readSlackMetadataFromMessageMetadata serves the neutral envelope before the nested one", () => {
    const metadata = JSON.stringify({
      assistantMessageChannel: "slack",
      providerMeta: JSON.stringify({
        source: "slack",
        conversationExternalId: "C123",
        messageId: "1700000000.000100",
        eventKind: "message",
      }),
    });
    expect(readSlackMetadataFromMessageMetadata(metadata)?.channelTs).toBe(
      "1700000000.000100",
    );
  });
});
