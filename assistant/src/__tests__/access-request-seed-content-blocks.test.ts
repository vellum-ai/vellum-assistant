import { describe, expect, test } from "bun:test";

import {
  buildAccessRequestSeedContentBlocks,
  parseAccessRequestPayload,
} from "../notifications/access-request-copy.js";

describe("buildAccessRequestSeedContentBlocks", () => {
  const basePayload: Record<string, unknown> = {
    requestId: "req-123",
    requestCode: "ABC123",
    sourceChannel: "slack",
    conversationExternalId: "C01ABC",
    actorExternalId: "U999",
    actorDisplayName: "Alice",
    actorUsername: "alice",
    senderIdentifier: "U999",
    messagePreview: "Hello, I need help with something",
    messageTs: "1700000000.000100",
  };

  test("produces a ui_surface block and a text fallback block", () => {
    const blocks = buildAccessRequestSeedContentBlocks(basePayload);
    expect(blocks).toHaveLength(2);
    expect((blocks[0] as Record<string, unknown>).type).toBe("ui_surface");
    expect((blocks[1] as Record<string, unknown>).type).toBe("text");
  });

  test("card surface has correct surfaceType and surfaceId", () => {
    const blocks = buildAccessRequestSeedContentBlocks(basePayload);
    const surface = blocks[0] as Record<string, unknown>;
    expect(surface.surfaceType).toBe("card");
    expect(surface.surfaceId).toBe("access-request-req-123");
    expect(surface.title).toBe("Access Request");
  });

  test("card data uses actorDisplayName as title", () => {
    const blocks = buildAccessRequestSeedContentBlocks(basePayload);
    const surface = blocks[0] as Record<string, unknown>;
    const data = surface.data as Record<string, unknown>;
    expect(data.title).toBe("Alice");
    expect(data.subtitle).toBe("Requesting access to the assistant");
  });

  test("card data falls back to senderIdentifier when no displayName", () => {
    const payload = { ...basePayload, actorDisplayName: undefined };
    const blocks = buildAccessRequestSeedContentBlocks(payload);
    const data = (blocks[0] as Record<string, unknown>).data as Record<
      string,
      unknown
    >;
    expect(data.title).toBe("U999");
  });

  test("card data falls back to 'Someone' when no identity", () => {
    const payload = {
      ...basePayload,
      actorDisplayName: undefined,
      senderIdentifier: undefined,
    };
    const blocks = buildAccessRequestSeedContentBlocks(payload);
    const data = (blocks[0] as Record<string, unknown>).data as Record<
      string,
      unknown
    >;
    expect(data.title).toBe("Someone");
  });

  test("includes username and source in metadata", () => {
    const blocks = buildAccessRequestSeedContentBlocks(basePayload);
    const data = (blocks[0] as Record<string, unknown>).data as Record<
      string,
      unknown
    >;
    const metadata = data.metadata as Array<{ label: string; value: string }>;
    expect(metadata).toContainEqual({
      label: "Username",
      value: "@alice",
    });
    expect(metadata).toContainEqual({
      label: "Source",
      value: "Slack — #C01ABC",
    });
  });

  test("DM channel renders as Direct message", () => {
    const payload = { ...basePayload, conversationExternalId: "D01XYZ" };
    const blocks = buildAccessRequestSeedContentBlocks(payload);
    const data = (blocks[0] as Record<string, unknown>).data as Record<
      string,
      unknown
    >;
    const metadata = data.metadata as Array<{ label: string; value: string }>;
    expect(metadata).toContainEqual({
      label: "Source",
      value: "Slack — Direct message",
    });
  });

  test("body includes message preview when present", () => {
    const blocks = buildAccessRequestSeedContentBlocks(basePayload);
    const data = (blocks[0] as Record<string, unknown>).data as Record<
      string,
      unknown
    >;
    expect(data.body).toContain("Hello, I need help with something");
  });

  test("body includes trust signal warnings", () => {
    const payload = {
      ...basePayload,
      isStranger: true,
      isRestricted: true,
      previousMemberStatus: "revoked",
    };
    const blocks = buildAccessRequestSeedContentBlocks(payload);
    const data = (blocks[0] as Record<string, unknown>).data as Record<
      string,
      unknown
    >;
    const body = data.body as string;
    expect(body).toContain("External Slack user");
    expect(body).toContain("Guest / restricted account");
    expect(body).toContain("previously revoked");
  });

  test("body includes Slack message permalink", () => {
    const blocks = buildAccessRequestSeedContentBlocks(basePayload);
    const data = (blocks[0] as Record<string, unknown>).data as Record<
      string,
      unknown
    >;
    const body = data.body as string;
    expect(body).toContain("View message");
    expect(body).toContain(
      "https://slack.com/archives/C01ABC/p1700000000000100",
    );
  });

  test("text fallback block contains contract text", () => {
    const blocks = buildAccessRequestSeedContentBlocks(basePayload);
    const textBlock = blocks[1] as Record<string, unknown>;
    expect(textBlock.type).toBe("text");
    const text = textBlock.text as string;
    expect(text).toContain("requesting access to the assistant");
    expect(text).toContain("ABC123");
  });

  test("body shows fallback when no preview/warnings/permalink", () => {
    const payload = {
      requestId: "req-456",
      requestCode: "XYZ",
      senderIdentifier: "someone",
    };
    const blocks = buildAccessRequestSeedContentBlocks(payload);
    const data = (blocks[0] as Record<string, unknown>).data as Record<
      string,
      unknown
    >;
    expect(data.body).toBe("No additional context available.");
  });

  test("surface block includes approve/reject actions when requestId present", () => {
    const blocks = buildAccessRequestSeedContentBlocks(basePayload);
    const surface = blocks[0] as Record<string, unknown>;
    const actions = surface.actions as Array<{
      id: string;
      label: string;
      style: string;
    }>;
    expect(actions).toHaveLength(2);
    expect(actions[0]).toEqual({
      id: "apr:req-123:approve_once",
      label: "Approve",
      style: "primary",
    });
    expect(actions[1]).toEqual({
      id: "apr:req-123:reject",
      label: "Reject",
      style: "destructive",
    });
  });

  test("surface block omits actions when requestId is missing", () => {
    const payload = {
      ...basePayload,
      requestId: undefined,
    };
    const blocks = buildAccessRequestSeedContentBlocks(payload);
    const surface = blocks[0] as Record<string, unknown>;
    expect(surface.actions).toBeUndefined();
  });

  test("parseAccessRequestPayload extracts typed fields", () => {
    const p = parseAccessRequestPayload(basePayload);
    expect(p.requestId).toBe("req-123");
    expect(p.actorDisplayName).toBe("Alice");
    expect(p.actorUsername).toBe("alice");
    expect(p.sourceChannel).toBe("slack");
    expect(p.isStranger).toBeUndefined();
    expect(p.isRestricted).toBeUndefined();
  });

  test("parseAccessRequestPayload handles boolean trust signals", () => {
    const p = parseAccessRequestPayload({
      ...basePayload,
      isStranger: true,
      isRestricted: true,
    });
    expect(p.isStranger).toBe(true);
    expect(p.isRestricted).toBe(true);
  });
});
