/**
 * Pins the seam between the Gmail watcher and the notification normalizer.
 *
 * A `format=metadata` fetch returns only the headers it is asked for, so the
 * header list and the payload shape are one contract with the normalizer, not
 * two independent details: a header dropped from either end silently collapses
 * every message to `fyi`. These tests run the real payload through the real
 * normalizer, so they fail if either end moves alone.
 */

import { describe, expect, test } from "bun:test";

import type { GmailMessage } from "../../messaging/providers/gmail/types.js";
import { gmailNormalizer } from "../../notifications/filter/normalize/gmail.js";
import { initializeDb } from "../../persistence/db-init.js";
import { messageToItem, METADATA_HEADERS } from "./gmail.js";

await initializeDb();

const MAILBOX = "owner@example.com";

function gmailMessage(headers: Record<string, string>): GmailMessage {
  return {
    id: "msg-1",
    threadId: "thread-1",
    labelIds: ["INBOX"],
    snippet: "Just checking in",
    internalDate: "1700000000000",
    payload: {
      headers: Object.entries(headers).map(([name, value]) => ({
        name,
        value,
      })),
    },
  };
}

const FROM = "Example User <user@example.com>";

function categoryOf(
  headers: Record<string, string>,
  mailbox: string | null = MAILBOX,
) {
  const item = messageToItem(gmailMessage({ From: FROM, ...headers }), mailbox);
  return gmailNormalizer.normalize(item)?.content.category;
}

describe("METADATA_HEADERS", () => {
  test("requests every header the normalizer categorizes on", () => {
    expect(METADATA_HEADERS).toEqual([
      "From",
      "Subject",
      "Date",
      "To",
      "Cc",
      "In-Reply-To",
      "List-Unsubscribe",
    ]);
  });
});

describe("messageToItem", () => {
  test("carries the fetched headers through to the payload", () => {
    const item = messageToItem(
      gmailMessage({
        From: FROM,
        Subject: "Hello",
        Date: "Sat, 1 Aug 2026 00:00:00 +0000",
        To: MAILBOX,
        Cc: "colleague@example.com",
        "In-Reply-To": "<parent@example.com>",
        "List-Unsubscribe": "<mailto:unsub@example.com>",
      }),
      MAILBOX,
    );

    expect(item.payload.headers).toEqual({
      From: FROM,
      Subject: "Hello",
      Date: "Sat, 1 Aug 2026 00:00:00 +0000",
      To: MAILBOX,
      Cc: "colleague@example.com",
      "In-Reply-To": "<parent@example.com>",
      "List-Unsubscribe": "<mailto:unsub@example.com>",
    });
  });

  test("keeps the top-level scalars existing readers index", () => {
    const item = messageToItem(
      gmailMessage({ From: FROM, Subject: "Hello", Date: "today" }),
      MAILBOX,
    );

    expect(item.payload.from).toBe(FROM);
    expect(item.payload.subject).toBe("Hello");
    expect(item.payload.date).toBe("today");
    expect(item.payload.id).toBe("msg-1");
    expect(item.payload.threadId).toBe("thread-1");
    expect(item.payload.snippet).toBe("Just checking in");
    expect(item.payload.labelIds).toEqual(["INBOX"]);
    expect(item.summary).toBe(`Email from ${FROM}: Hello`);
  });

  test("omits headers the message does not carry", () => {
    const item = messageToItem(gmailMessage({ From: FROM }), MAILBOX);
    expect(item.payload.headers).toEqual({ From: FROM });
  });

  test("stamps the mailbox address, and omits it when unknown", () => {
    expect(
      messageToItem(gmailMessage({ From: FROM }), MAILBOX).payload
        .mailboxAddress,
    ).toBe(MAILBOX);
    expect(
      messageToItem(gmailMessage({ From: FROM }), null).payload,
    ).not.toHaveProperty("mailboxAddress");
  });
});

describe("the payload the normalizer categorizes", () => {
  test("mail addressed to the mailbox alone reaches dm", () => {
    expect(categoryOf({ To: `The Owner <${MAILBOX}>` })).toBe("dm");
  });

  test("a dm with a colleague copied is still a dm", () => {
    expect(categoryOf({ To: MAILBOX, Cc: "colleague@example.com" })).toBe("dm");
  });

  test("a one-address list alias does not reach dm", () => {
    expect(categoryOf({ To: "team-announce@example.com" })).toBe("fyi");
  });

  test("In-Reply-To reaches reply", () => {
    expect(
      categoryOf({
        To: "team@example.com, other@example.com",
        "In-Reply-To": "<parent@example.com>",
      }),
    ).toBe("reply");
  });

  test("List-Unsubscribe reaches broadcast", () => {
    expect(
      categoryOf({
        To: MAILBOX,
        "List-Unsubscribe": "<mailto:unsub@example.com>",
      }),
    ).toBe("broadcast");
  });

  test("without a mailbox address a sole recipient does not reach dm", () => {
    expect(categoryOf({ To: MAILBOX }, null)).toBe("fyi");
  });
});
