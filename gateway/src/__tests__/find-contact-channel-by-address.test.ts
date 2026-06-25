/**
 * Tests for findContactChannelByAddress: resolves the contact's display name
 * from the gateway's own contact store (not the assistant DB), matching the
 * (type, address) key case-insensitively.
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
} from "bun:test";

import "./test-preload.js";

import {
  initGatewayDb,
  getGatewayDb,
  resetGatewayDb,
} from "../db/connection.js";
import { contacts, contactChannels } from "../db/schema.js";
import { findContactChannelByAddress } from "../verification/contact-helpers.js";

beforeAll(async () => {
  await initGatewayDb();
});

beforeEach(() => {
  const db = getGatewayDb();
  db.delete(contactChannels).run();
  db.delete(contacts).run();
});

afterAll(() => {
  resetGatewayDb();
});

function seed(opts: { displayName: string; type: string; address: string }) {
  const now = Date.now();
  getGatewayDb()
    .insert(contacts)
    .values({
      id: "c1",
      displayName: opts.displayName,
      role: "contact",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  getGatewayDb()
    .insert(contactChannels)
    .values({
      id: "ch1",
      contactId: "c1",
      type: opts.type,
      address: opts.address,
      isPrimary: false,
      status: "active",
      policy: "allow",
      interactionCount: 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

describe("findContactChannelByAddress", () => {
  test("returns the gateway contact's display name on an exact match", () => {
    seed({ displayName: "Ada", type: "telegram", address: "U123" });
    expect(findContactChannelByAddress("telegram", "U123")).toEqual({
      displayName: "Ada",
    });
  });

  test("matches address case-insensitively", () => {
    seed({ displayName: "Ada", type: "telegram", address: "U123" });
    expect(findContactChannelByAddress("telegram", "u123")).toEqual({
      displayName: "Ada",
    });
  });

  test("returns null when no gateway row matches", () => {
    seed({ displayName: "Ada", type: "telegram", address: "U123" });
    expect(findContactChannelByAddress("telegram", "other")).toBeNull();
    expect(findContactChannelByAddress("slack", "U123")).toBeNull();
  });
});
