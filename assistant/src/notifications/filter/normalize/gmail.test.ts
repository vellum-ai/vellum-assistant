/**
 * Pins the Gmail mapping, including the split the whole tiering design rests
 * on: `normalize` is pure and leaves `content.full` null, and only `fetchFull`
 * spends an API call on the body.
 *
 * The Gmail client and OAuth mocks below delegate to the real implementations
 * by default, so the stubs installed here cannot change behaviour for any
 * other test file.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { upsertContact } from "../../../contacts/contact-store.js";
import type { GmailMessage } from "../../../messaging/providers/gmail/types.js";
import { getSqlite } from "../../../persistence/db-connection.js";
import { initializeDb } from "../../../persistence/db-init.js";
import type { WatcherItem } from "../../../watcher/provider-types.js";

const actualGmailClient =
  await import("../../../messaging/providers/gmail/client.js");
type BatchGetMessages = typeof actualGmailClient.batchGetMessages;
let batchGetMessagesImpl: BatchGetMessages = actualGmailClient.batchGetMessages;
const batchGetMessagesMock = mock(((...args: Parameters<BatchGetMessages>) =>
  batchGetMessagesImpl(...args)) as BatchGetMessages);
mock.module("../../../messaging/providers/gmail/client.js", () => ({
  ...actualGmailClient,
  batchGetMessages: batchGetMessagesMock,
}));

const actualConnectionResolver =
  await import("../../../oauth/connection-resolver.js");
type ResolveOAuthConnection =
  typeof actualConnectionResolver.resolveOAuthConnection;
let resolveOAuthConnectionImpl: ResolveOAuthConnection =
  actualConnectionResolver.resolveOAuthConnection;
mock.module("../../../oauth/connection-resolver.js", () => ({
  ...actualConnectionResolver,
  resolveOAuthConnection: ((...args: Parameters<ResolveOAuthConnection>) =>
    resolveOAuthConnectionImpl(...args)) as ResolveOAuthConnection,
}));

const { gmailNormalizer } = await import("./gmail.js");
const { NormalizedNotificationSchema } = await import("./types.js");

await initializeDb();

function gmailItem(payload: Record<string, unknown> = {}): WatcherItem {
  return {
    externalId: "msg-1",
    eventType: "new_email",
    summary: "Email from Example User <user@example.com>: Hello",
    payload: {
      id: "msg-1",
      threadId: "thread-1",
      from: "Example User <user@example.com>",
      subject: "Hello",
      date: "Sat, 1 Aug 2026 00:00:00 +0000",
      snippet: "Just checking in",
      labelIds: ["INBOX"],
      mailboxAddress: "owner@example.com",
      ...payload,
    },
    timestamp: 1_700_000_000_000,
  };
}

beforeEach(() => {
  const sqlite = getSqlite();
  sqlite.run("DELETE FROM contact_channels");
  sqlite.run("DELETE FROM contacts");
  resolveOAuthConnectionImpl = (async () => ({}) as never) as never;
  batchGetMessagesImpl = async () => [];
  batchGetMessagesMock.mockClear();
});

afterAll(() => {
  resolveOAuthConnectionImpl = actualConnectionResolver.resolveOAuthConnection;
  batchGetMessagesImpl = actualGmailClient.batchGetMessages;
});

describe("gmailNormalizer.normalize", () => {
  test("produces a schema-valid record from a watcher payload", () => {
    const result = gmailNormalizer.normalize(gmailItem());
    expect(result).not.toBeNull();
    expect(NormalizedNotificationSchema.parse(result)).toEqual(result!);
    expect(result!.source).toBe("gmail");
    expect(result!.externalId).toBe("msg-1");
    expect(result!.content.preview).toBe("Just checking in");
    expect(result!.container).toEqual({
      type: "inbox",
      id: "thread-1",
      displayName: null,
    });
  });

  test("performs no network I/O and leaves full null", () => {
    const result = gmailNormalizer.normalize(gmailItem());
    expect(result!.content.full).toBeNull();
    expect(batchGetMessagesMock).not.toHaveBeenCalled();
  });

  test("parses the From header into a display name and address", () => {
    const result = gmailNormalizer.normalize(gmailItem());
    expect(result!.sender?.rawId).toBe("user@example.com");
    expect(result!.sender?.displayName).toBe("Example User");
  });

  test("treats a bare address as its own display name", () => {
    const result = gmailNormalizer.normalize(
      gmailItem({ from: "user@example.com" }),
    );
    expect(result!.sender).toEqual({
      rawId: "user@example.com",
      displayName: "user@example.com",
      contactId: null,
    });
  });

  test("drops an item with neither a snippet nor a subject", () => {
    expect(
      gmailNormalizer.normalize(gmailItem({ snippet: "", subject: "" })),
    ).toBeNull();
  });

  test("falls back to the subject when the snippet is empty", () => {
    const result = gmailNormalizer.normalize(gmailItem({ snippet: "" }));
    expect(result!.content.preview).toBe("Hello");
  });

  test("populates contactId when the sender is a known contact", () => {
    const contact = upsertContact({
      displayName: "Example User",
      channels: [{ type: "email", address: "user@example.com" }],
    });

    expect(gmailNormalizer.normalize(gmailItem())!.sender?.contactId).toBe(
      contact.id,
    );
  });

  test("leaves contactId null when the sender is unknown", () => {
    expect(
      gmailNormalizer.normalize(gmailItem())!.sender?.contactId,
    ).toBeNull();
  });
});

describe("gmailNormalizer category mapping", () => {
  test("List-Unsubscribe marks a broadcast", () => {
    const result = gmailNormalizer.normalize(
      gmailItem({
        headers: { "List-Unsubscribe": "<mailto:unsub@example.com>" },
        to: "user@example.com",
      }),
    );
    expect(result!.content.category).toBe("broadcast");
  });

  test("a promotions label marks a broadcast", () => {
    const result = gmailNormalizer.normalize(
      gmailItem({ labelIds: ["INBOX", "CATEGORY_PROMOTIONS"] }),
    );
    expect(result!.content.category).toBe("broadcast");
  });

  test("an updates label marks a broadcast", () => {
    const result = gmailNormalizer.normalize(
      gmailItem({ labelIds: ["INBOX", "CATEGORY_UPDATES"] }),
    );
    expect(result!.content.category).toBe("broadcast");
  });

  test("mail addressed to the mailbox alone is a dm", () => {
    const result = gmailNormalizer.normalize(
      gmailItem({ to: "owner@example.com" }),
    );
    expect(result!.content.category).toBe("dm");
  });

  test("matches the mailbox by address, not by the whole header", () => {
    const result = gmailNormalizer.normalize(
      gmailItem({ to: "The Owner <Owner@Example.com>" }),
    );
    expect(result!.content.category).toBe("dm");
  });

  test("a dm with someone else copied is still a dm", () => {
    const result = gmailNormalizer.normalize(
      gmailItem({
        to: "owner@example.com",
        cc: "colleague@example.com, another@example.com",
      }),
    );
    expect(result!.content.category).toBe("dm");
  });

  test("a one-address list alias is not a dm", () => {
    const result = gmailNormalizer.normalize(
      gmailItem({ to: "team-announce@example.com" }),
    );
    expect(result!.content.category).toBe("fyi");
  });

  test("mail naming the mailbox among other recipients is not a dm", () => {
    const result = gmailNormalizer.normalize(
      gmailItem({ to: "owner@example.com, other@example.com" }),
    );
    expect(result!.content.category).toBe("fyi");
  });

  test("without a mailbox address a sole recipient is not a dm", () => {
    const result = gmailNormalizer.normalize(
      gmailItem({ to: "owner@example.com", mailboxAddress: undefined }),
    );
    expect(result!.content.category).toBe("fyi");
  });

  test("In-Reply-To on a multi-recipient thread is a reply", () => {
    const result = gmailNormalizer.normalize(
      gmailItem({
        to: "owner@example.com, other@example.com",
        headers: { "In-Reply-To": "<parent@example.com>" },
      }),
    );
    expect(result!.content.category).toBe("reply");
  });

  test("a reply addressed to the mailbox alone is a dm", () => {
    const result = gmailNormalizer.normalize(
      gmailItem({
        to: "owner@example.com",
        headers: { "In-Reply-To": "<parent@example.com>" },
      }),
    );
    expect(result!.content.category).toBe("dm");
  });

  test("reads the categorizing headers out of the watcher headers record", () => {
    const result = gmailNormalizer.normalize(
      gmailItem({
        to: undefined,
        headers: {
          To: "owner@example.com",
          "In-Reply-To": "<parent@example.com>",
        },
      }),
    );
    expect(result!.content.category).toBe("dm");
  });

  test("anything else is fyi", () => {
    const result = gmailNormalizer.normalize(
      gmailItem({ to: "owner@example.com, other@example.com" }),
    );
    expect(result!.content.category).toBe("fyi");
  });
});

describe("gmailNormalizer.fetchFull", () => {
  const normalized = () => gmailNormalizer.normalize(gmailItem())!;

  const FULL_MESSAGE: GmailMessage = {
    id: "msg-1",
    threadId: "thread-1",
    payload: {
      mimeType: "text/plain",
      body: { data: Buffer.from("The whole body").toString("base64url") },
    },
  };

  test("is defined: Gmail's poll yields only a snippet", () => {
    expect(gmailNormalizer.fetchFull).toBeDefined();
  });

  test("issues exactly one request and returns the plain-text body", async () => {
    batchGetMessagesImpl = async () => [FULL_MESSAGE];

    await expect(gmailNormalizer.fetchFull!(normalized())).resolves.toBe(
      "The whole body",
    );
    expect(batchGetMessagesMock).toHaveBeenCalledTimes(1);
    const [, ids, format] = batchGetMessagesMock.mock.calls[0]!;
    expect(ids).toEqual(["msg-1"]);
    expect(format).toBe("full");
  });

  test("converts an HTML-only body rather than returning the snippet", async () => {
    batchGetMessagesImpl = async () => [
      {
        id: "msg-1",
        threadId: "thread-1",
        snippet: "The whole b",
        payload: {
          mimeType: "multipart/alternative",
          parts: [
            {
              mimeType: "text/html",
              body: {
                data: Buffer.from(
                  "<html><body><p>The whole body</p><p>Second &amp; last</p></body></html>",
                ).toString("base64url"),
              },
            },
          ],
        },
      },
    ];

    await expect(gmailNormalizer.fetchFull!(normalized())).resolves.toBe(
      "The whole body\n\nSecond & last",
    );
  });

  test("returns null when the fetch fails", async () => {
    batchGetMessagesImpl = async () => {
      throw new Error("gmail 500");
    };

    await expect(gmailNormalizer.fetchFull!(normalized())).resolves.toBeNull();
  });

  test("returns null when the connection cannot be resolved", async () => {
    resolveOAuthConnectionImpl = (async () => {
      throw new Error("no credential");
    }) as never;

    await expect(gmailNormalizer.fetchFull!(normalized())).resolves.toBeNull();
    expect(batchGetMessagesMock).not.toHaveBeenCalled();
  });

  test("returns null when the message comes back empty", async () => {
    batchGetMessagesImpl = async () => [];

    await expect(gmailNormalizer.fetchFull!(normalized())).resolves.toBeNull();
  });
});
