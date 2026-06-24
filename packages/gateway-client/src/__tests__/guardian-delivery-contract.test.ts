/**
 * Tests for the guardian binding + delivery pull contract.
 */

import { describe, expect, test } from "bun:test";

import {
  GuardianDeliverySchema,
  ResolveGuardianDeliveryRequestSchema,
  type GuardianDelivery,
} from "../guardian-delivery-contract.js";

const fullGuardian: GuardianDelivery = {
  channelType: "imessage",
  contactId: "c1",
  principalId: "p1",
  displayName: "Guardian Name",
  address: "+15555550100",
  externalChatId: "ext-chat-1",
  status: "active",
  verifiedAt: 1699999999,
};

describe("ResolveGuardianDeliveryRequestSchema", () => {
  test("parses with channelTypes", () => {
    const req = { channelTypes: ["imessage", "sms"] };
    expect(ResolveGuardianDeliveryRequestSchema.parse(req)).toEqual(req);
  });

  test("parses with channelTypes omitted", () => {
    expect(ResolveGuardianDeliveryRequestSchema.parse({})).toEqual({});
  });

  test("defaults to {} when params are undefined (no-param IPC call)", () => {
    expect(ResolveGuardianDeliveryRequestSchema.parse(undefined)).toEqual({});
  });
});

describe("GuardianDeliverySchema", () => {
  test("round-trips a fully-populated row", () => {
    expect(GuardianDeliverySchema.parse(fullGuardian)).toEqual(fullGuardian);
  });

  test("requires channelType", () => {
    const { channelType: _omit, ...rest } = fullGuardian;
    expect(() => GuardianDeliverySchema.parse(rest)).toThrow();
  });

  test("requires contactId", () => {
    const { contactId: _omit, ...rest } = fullGuardian;
    expect(() => GuardianDeliverySchema.parse(rest)).toThrow();
  });

  test("requires address", () => {
    const { address: _omit, ...rest } = fullGuardian;
    expect(() => GuardianDeliverySchema.parse(rest)).toThrow();
  });

  test("requires status", () => {
    const { status: _omit, ...rest } = fullGuardian;
    expect(() => GuardianDeliverySchema.parse(rest)).toThrow();
  });

  test("optional fields accept null", () => {
    const row = {
      channelType: "imessage",
      contactId: "c1",
      address: "+15555550100",
      status: "active",
      principalId: null,
      displayName: null,
      externalChatId: null,
      verifiedAt: null,
    } satisfies GuardianDelivery;
    expect(GuardianDeliverySchema.parse(row)).toEqual(row);
  });

  test("optional fields accept undefined (omitted)", () => {
    const row = {
      channelType: "imessage",
      contactId: "c1",
      address: "+15555550100",
      status: "active",
    } satisfies GuardianDelivery;
    const parsed = GuardianDeliverySchema.parse(row);
    expect(parsed.principalId).toBeUndefined();
    expect(parsed.displayName).toBeUndefined();
    expect(parsed.externalChatId).toBeUndefined();
    expect(parsed.verifiedAt).toBeUndefined();
  });
});
