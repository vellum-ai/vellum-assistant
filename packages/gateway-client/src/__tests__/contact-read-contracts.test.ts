/**
 * Tests for the contact read IPC contracts in gateway-ipc-contracts.ts.
 */

import { describe, expect, test } from "bun:test";

import {
  ContactReadSchema,
  GetContactIpcParamsSchema,
  ListContactsIpcParamsSchema,
} from "../gateway-ipc-contracts.js";

describe("contact read contracts", () => {
  test("ContactReadSchema parses a fully-populated contact", () => {
    const contact = {
      id: "c1",
      displayName: "Ada Lovelace",
      role: "guardian",
      notes: "primary guardian",
      contactType: "human",
      lastInteraction: 1700000000,
      interactionCount: 12,
      channels: [
        {
          id: "ch1",
          contactId: "c1",
          type: "imessage",
          address: "+15551234567",
          isPrimary: true,
          externalUserId: "+15551234567",
          status: "active",
          policy: "allow",
          verifiedAt: 1699999999,
          verifiedVia: "voice",
          lastSeenAt: 1700000001,
          interactionCount: 12,
          lastInteraction: 1700000000,
          revokedReason: null,
          blockedReason: null,
        },
      ],
    };

    expect(() => ContactReadSchema.parse(contact)).not.toThrow();
  });

  test("ListContactsIpcParamsSchema defaults to {} when given undefined", () => {
    expect(ListContactsIpcParamsSchema.parse(undefined)).toEqual({});
  });

  test("GetContactIpcParamsSchema rejects an empty object", () => {
    expect(() => GetContactIpcParamsSchema.parse({})).toThrow();
  });
});
