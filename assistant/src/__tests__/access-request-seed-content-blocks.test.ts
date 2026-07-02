import { describe, expect, test } from "bun:test";

import { parseAccessRequestPayload } from "../notifications/access-request-copy.js";
import type {
  ApprovalCardBlock,
  ApprovalCardFallbackBlock,
  ApprovalCardSurfaceBlock,
} from "../notifications/approval-card-builder.js";
import { buildAccessRequestSeedContentBlocks } from "../notifications/approval-card-data.js";

// The builder returns a schema-derived `ApprovalCardBlock[]`, so tests narrow by
// the block's discriminant instead of casting to `Record<string, unknown>`.
function surfaceOf(blocks: ApprovalCardBlock[]): ApprovalCardSurfaceBlock {
  const block = blocks[0];
  if (block?.type !== "ui_surface") {
    throw new Error("expected a ui_surface block at index 0");
  }
  return block;
}
function textOf(blocks: ApprovalCardBlock[]): ApprovalCardFallbackBlock {
  const block = blocks[1];
  if (block?.type !== "text") {
    throw new Error("expected a text fallback block at index 1");
  }
  return block;
}

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
    expect(surfaceOf(blocks).type).toBe("ui_surface");
    expect(textOf(blocks).type).toBe("text");
    // The fallback block is flagged so surface-capable clients skip it.
    expect(textOf(blocks)._surfaceFallback).toBe(true);
  });

  test("card surface has correct surfaceType and surfaceId", () => {
    const surface = surfaceOf(buildAccessRequestSeedContentBlocks(basePayload));
    expect(surface.surfaceType).toBe("card");
    expect(surface.surfaceId).toBe("access-request-req-123");
    expect(surface.title).toBe("Access Request");
  });

  test("card data uses actorDisplayName as title", () => {
    const { data } = surfaceOf(
      buildAccessRequestSeedContentBlocks(basePayload),
    );
    expect(data.title).toBe("Alice");
    expect(data.subtitle).toBe("Requesting access to the assistant");
  });

  test("card data falls back to senderIdentifier when no displayName", () => {
    const blocks = buildAccessRequestSeedContentBlocks({
      ...basePayload,
      actorDisplayName: undefined,
    });
    expect(surfaceOf(blocks).data.title).toBe("U999");
  });

  test("card data falls back to 'Someone' when no identity", () => {
    const blocks = buildAccessRequestSeedContentBlocks({
      ...basePayload,
      actorDisplayName: undefined,
      senderIdentifier: undefined,
    });
    expect(surfaceOf(blocks).data.title).toBe("Someone");
  });

  test("includes username and source in metadata", () => {
    const { data } = surfaceOf(
      buildAccessRequestSeedContentBlocks(basePayload),
    );
    expect(data.metadata).toContainEqual({
      label: "Username",
      value: "@alice",
    });
    expect(data.metadata).toContainEqual({
      label: "Source",
      value: "Slack — #C01ABC",
    });
  });

  test("DM channel renders as Direct message", () => {
    const blocks = buildAccessRequestSeedContentBlocks({
      ...basePayload,
      conversationExternalId: "D01XYZ",
    });
    expect(surfaceOf(blocks).data.metadata).toContainEqual({
      label: "Source",
      value: "Slack — Direct message",
    });
  });

  test("body includes message preview when present", () => {
    const { data } = surfaceOf(
      buildAccessRequestSeedContentBlocks(basePayload),
    );
    expect(data.body).toContain("Hello, I need help with something");
  });

  test("body includes trust signal warnings", () => {
    const { data } = surfaceOf(
      buildAccessRequestSeedContentBlocks({
        ...basePayload,
        isStranger: true,
        isRestricted: true,
        previousMemberStatus: "revoked",
      }),
    );
    expect(data.body).toContain("External Slack user");
    expect(data.body).toContain("Guest / restricted account");
    expect(data.body).toContain("previously revoked");
  });

  test("body includes Slack message permalink", () => {
    const { data } = surfaceOf(
      buildAccessRequestSeedContentBlocks(basePayload),
    );
    expect(data.body).toContain("View message");
    expect(data.body).toContain(
      "https://slack.com/archives/C01ABC/p1700000000000100",
    );
  });

  test("text fallback block contains contract text", () => {
    const textBlock = textOf(buildAccessRequestSeedContentBlocks(basePayload));
    expect(textBlock.text).toContain("requesting access to the assistant");
    expect(textBlock.text).toContain("ABC123");
  });

  test("body shows fallback when no preview/warnings/permalink", () => {
    const blocks = buildAccessRequestSeedContentBlocks({
      requestId: "req-456",
      requestCode: "XYZ",
      senderIdentifier: "someone",
    });
    expect(surfaceOf(blocks).data.body).toBe(
      "No additional context available.",
    );
  });

  test("surface block renders introduction actions for a workspace member (no code option)", () => {
    // Explicit positive signals: users.info resolved a regular member.
    const surface = surfaceOf(
      buildAccessRequestSeedContentBlocks({
        ...basePayload,
        isStranger: false,
        isRestricted: false,
      }),
    );
    expect(surface.actions).toEqual([
      { id: "apr:req-123:trust", label: "Trust", style: "primary" },
      {
        id: "apr:req-123:leave_unverified",
        label: "Leave unverified",
        style: "secondary",
      },
      { id: "apr:req-123:block", label: "Block", style: "destructive" },
    ]);
  });

  test("surface block leads with the handshake for an external Slack user", () => {
    const surface = surfaceOf(
      buildAccessRequestSeedContentBlocks({ ...basePayload, isStranger: true }),
    );
    // Unknown signals (users.info failure) render the same handshake-led
    // shape — absent platform vouching must never yield one-tap Trust.
    const unknownSignals = surfaceOf(
      buildAccessRequestSeedContentBlocks(basePayload),
    );
    expect(unknownSignals.actions?.map((a) => a.id)).toEqual(
      surface.actions?.map((a) => a.id) ?? [],
    );
    expect(surface.actions).toEqual([
      {
        id: "apr:req-123:verify_code",
        label: "Verify with a code",
        style: "primary",
      },
      { id: "apr:req-123:trust", label: "Trust anyway", style: "secondary" },
      {
        id: "apr:req-123:leave_unverified",
        label: "Leave unverified",
        style: "secondary",
      },
      { id: "apr:req-123:block", label: "Block", style: "destructive" },
    ]);
  });

  test("surface block never offers the code option for a bot", () => {
    const surface = surfaceOf(
      buildAccessRequestSeedContentBlocks({
        ...basePayload,
        isBot: true,
        isStranger: true,
      }),
    );
    const ids = (surface.actions ?? []).map((a) => a.id);
    expect(ids).toEqual([
      "apr:req-123:trust",
      "apr:req-123:leave_unverified",
      "apr:req-123:block",
    ]);
  });

  test("surface block omits actions when requestId is missing", () => {
    const blocks = buildAccessRequestSeedContentBlocks({
      ...basePayload,
      requestId: undefined,
    });
    expect(surfaceOf(blocks).actions).toBeUndefined();
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
