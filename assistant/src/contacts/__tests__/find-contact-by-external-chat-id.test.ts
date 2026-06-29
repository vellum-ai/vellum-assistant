/**
 * findContactChannel's externalChatId fallback must prefer the primary channel
 * among duplicate (type, externalChatId) rows. externalChatId has no unique
 * constraint, so a revoked/blocked duplicate (more recently touched) must not
 * win over the active/primary one.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { getDb } from "../../persistence/db-connection.js";
import { initializeDb } from "../../persistence/db-init.js";
import {
  contactChannels,
  contacts,
} from "../../persistence/schema/index.js";
import { findContactChannel } from "../contact-store.js";

await initializeDb();

const TYPE = "telegram";
const EXT_CHAT = "shared-chat-123";

function seedContact(id: string, ts: number): void {
  getDb()
    .insert(contacts)
    .values({
      id,
      displayName: id,
      contactType: "human",
      createdAt: ts,
      updatedAt: ts,
    })
    .run();
}

function seedChannel(params: {
  id: string;
  contactId: string;
  address: string;
  isPrimary: boolean;
  updatedAt: number;
  createdAt: number;
}): void {
  getDb()
    .insert(contactChannels)
    .values({
      id: params.id,
      contactId: params.contactId,
      type: TYPE,
      address: params.address,
      isPrimary: params.isPrimary,
      externalChatId: EXT_CHAT,
      updatedAt: params.updatedAt,
      createdAt: params.createdAt,
    })
    .run();
}

describe("findContactChannel — duplicate externalChatId tiebreak", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM contact_channels");
    db.run("DELETE FROM contacts");
  });

  test("prefers the primary channel over a more-recently-updated duplicate", () => {
    // The non-primary duplicate is updated LATER (a revoke/blocked touch would
    // bump updatedAt), so pure recency would wrongly pick it.
    seedContact("c-active", 100);
    seedContact("c-stale", 100);
    seedChannel({
      id: "ch-active",
      contactId: "c-active",
      address: "@active",
      isPrimary: true,
      createdAt: 100,
      updatedAt: 100,
    });
    seedChannel({
      id: "ch-stale",
      contactId: "c-stale",
      address: "@stale",
      isPrimary: false,
      createdAt: 100,
      updatedAt: 999, // newer
    });

    const found = findContactChannel({
      channelType: TYPE,
      externalChatId: EXT_CHAT,
    });

    expect(found?.contact.id).toBe("c-active");
    expect(found?.channel.id).toBe("ch-active");
  });

  test("falls back to recency when no duplicate is primary", () => {
    seedContact("c-old", 100);
    seedContact("c-new", 100);
    seedChannel({
      id: "ch-old",
      contactId: "c-old",
      address: "@old",
      isPrimary: false,
      createdAt: 100,
      updatedAt: 100,
    });
    seedChannel({
      id: "ch-new",
      contactId: "c-new",
      address: "@new",
      isPrimary: false,
      createdAt: 100,
      updatedAt: 500,
    });

    const found = findContactChannel({
      channelType: TYPE,
      externalChatId: EXT_CHAT,
    });

    expect(found?.contact.id).toBe("c-new");
  });
});
