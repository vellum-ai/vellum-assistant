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
      displayName: "Example User",
      role: "guardian",
      notes: "primary guardian",
      contactType: "human",
      lastInteraction: 1700000000,
      interactionCount: 12,
      createdAt: 1699000000,
      updatedAt: 1700000000,
      channels: [
        {
          id: "ch1",
          contactId: "c1",
          type: "imessage",
          address: "+15555550100",
          isPrimary: true,
          externalUserId: "+15555550100",
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

    const parsed = ContactReadSchema.parse(contact);
    expect(parsed.createdAt).toBe(1699000000);
    expect(parsed.updatedAt).toBe(1700000000);
  });

  test("ContactReadSchema accepts null interactionCount (daemon-native gateway-telemetry outage fail-soft)", () => {
    const contact = {
      id: "c1",
      displayName: "Example User",
      role: "contact",
      contactType: "human",
      lastInteraction: null,
      interactionCount: null,
      createdAt: 1699000000,
      updatedAt: 1700000000,
      channels: [
        {
          id: "ch1",
          contactId: "c1",
          type: "imessage",
          address: "+15555550100",
          isPrimary: true,
          externalUserId: null,
          status: "active",
          policy: "allow",
          verifiedAt: null,
          verifiedVia: null,
          lastSeenAt: null,
          interactionCount: null,
          lastInteraction: null,
          revokedReason: null,
          blockedReason: null,
        },
      ],
    };

    const parsed = ContactReadSchema.parse(contact);
    expect(parsed.interactionCount).toBeNull();
    expect(parsed.channels[0].interactionCount).toBeNull();
  });

  test("ContactReadSchema requires createdAt/updatedAt", () => {
    const withoutTimestamps = {
      id: "c1",
      displayName: "Example User",
      role: "contact",
      interactionCount: 0,
      channels: [],
    };
    expect(() => ContactReadSchema.parse(withoutTimestamps)).toThrow();
  });

  test("ListContactsIpcParamsSchema defaults to {} when given undefined", () => {
    expect(ListContactsIpcParamsSchema.parse(undefined)).toEqual({});
  });

  test("GetContactIpcParamsSchema rejects an empty object", () => {
    expect(() => GetContactIpcParamsSchema.parse({})).toThrow();
  });
});
