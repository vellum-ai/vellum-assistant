/**
 * Pins the normalized-record contract: null is a first-class value for a
 * source that has nothing to put in a field, but `content.preview` is the one
 * thing every source must supply.
 */

import { describe, expect, test } from "bun:test";

import {
  type NormalizedNotification,
  NormalizedNotificationSchema,
} from "./types.js";

const LINEAR_RECORD: NormalizedNotification = {
  source: "linear",
  externalId: "notif-1",
  credentialService: null,
  sender: null,
  container: { type: "project", id: "issue-1", displayName: "Team One" },
  content: {
    preview: "Linear issue assigned to you",
    full: "Ship the thing",
    category: "assignment",
  },
  meta: {
    timestamp: 1_700_000_000_000,
    nativePriority: null,
    threadReplyCount: null,
    hasAttachments: null,
  },
};

describe("NormalizedNotificationSchema", () => {
  test("accepts a Linear record with no sender", () => {
    const parsed = NormalizedNotificationSchema.parse(LINEAR_RECORD);
    expect(parsed.sender).toBeNull();
    expect(parsed.container?.type).toBe("project");
  });

  test("accepts a record whose sender fields are individually null", () => {
    const parsed = NormalizedNotificationSchema.parse({
      ...LINEAR_RECORD,
      sender: { rawId: null, displayName: null, contactId: null },
    });
    expect(parsed.sender).toEqual({
      rawId: null,
      displayName: null,
      contactId: null,
    });
  });

  test("rejects a record with no preview", () => {
    const result = NormalizedNotificationSchema.safeParse({
      ...LINEAR_RECORD,
      content: { full: null, category: "fyi" },
    });
    expect(result.success).toBe(false);
  });

  test("rejects an empty preview", () => {
    const result = NormalizedNotificationSchema.safeParse({
      ...LINEAR_RECORD,
      content: { ...LINEAR_RECORD.content, preview: "" },
    });
    expect(result.success).toBe(false);
  });

  test("defaults a record with no credential service to null", () => {
    const { credentialService: _omitted, ...withoutService } = LINEAR_RECORD;
    const parsed = NormalizedNotificationSchema.parse(withoutService);
    expect(parsed.credentialService).toBeNull();
  });

  test("keeps the credential service a record carries", () => {
    const parsed = NormalizedNotificationSchema.parse({
      ...LINEAR_RECORD,
      credentialService: "google-work",
    });
    expect(parsed.credentialService).toBe("google-work");
  });

  test("accepts a null container", () => {
    const parsed = NormalizedNotificationSchema.parse({
      ...LINEAR_RECORD,
      container: null,
    });
    expect(parsed.container).toBeNull();
  });
});
