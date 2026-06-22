import { describe, expect, test } from "bun:test";

import type {
  ApprovalCardBlock,
  ApprovalCardFallbackBlock,
  ApprovalCardSurfaceBlock,
} from "../notifications/approval-card-builder.js";
import { buildToolApprovalSeedContentBlocks } from "../notifications/approval-card-data.js";

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

/**
 * Pins the in-app tool-approval card seed content. The card is reframed
 * assistant-as-actor: the primary line names the tool (not the contact), a
 * connective attributes the action to the triggering message, the body shows
 * the requester's words + an exact-message Slack link, and the same one-line
 * phrasing feeds the plain-text fallback.
 */
describe("buildToolApprovalSeedContentBlocks", () => {
  const slackChannelGrant: Record<string, unknown> = {
    requestId: "req-grant-1",
    requestCode: "XYZ789",
    requestKind: "tool_grant_request",
    toolName: "web_fetch",
    questionText:
      'Assistant wants to use "web_fetch" in response to Noa Flaherty\'s message in #general.',
    sourceChannel: "slack",
    requesterIdentifier: "Noa Flaherty",
    conversationExternalId: "C01ABC",
    channelName: "general",
    messageTs: "1700000000.000100",
    messagePreview: "can you pull this? https://example.com/article",
    commandPreview: "GET https://example.com/article",
  };

  test("returns null for non-tool-approval request kinds", () => {
    expect(
      buildToolApprovalSeedContentBlocks({ requestKind: "pending_question" }),
    ).toBeNull();
    expect(
      buildToolApprovalSeedContentBlocks({ requestKind: "access_request" }),
    ).toBeNull();
    expect(buildToolApprovalSeedContentBlocks({})).toBeNull();
  });

  test("emits a ui_surface card + flagged text fallback", () => {
    const blocks = buildToolApprovalSeedContentBlocks(slackChannelGrant)!;
    expect(blocks).toHaveLength(2);
    expect(surfaceOf(blocks).surfaceType).toBe("card");
    expect(surfaceOf(blocks).surfaceId).toBe("tool-approval-req-grant-1");
    expect(textOf(blocks)._surfaceFallback).toBe(true);
  });

  test("primary line is the assistant-as-actor title, not the contact", () => {
    const surface = surfaceOf(
      buildToolApprovalSeedContentBlocks(slackChannelGrant)!,
    );
    expect(surface.data.title).toBe('Assistant wants to use "web_fetch"');
    expect(surface.data.title).not.toContain("Noa");
    // Generic category header lives in surface.title, not the contact's name.
    expect(surface.title).toBe("Tool approval");
  });

  test("channel message: subtitle attributes the sender + channel", () => {
    const surface = surfaceOf(
      buildToolApprovalSeedContentBlocks(slackChannelGrant)!,
    );
    expect(surface.data.subtitle).toBe(
      "in response to Noa Flaherty's message in #general",
    );
  });

  test("body shows the requester's words, the command, and a Slack link", () => {
    const { body } = surfaceOf(
      buildToolApprovalSeedContentBlocks(slackChannelGrant)!,
    ).data;
    expect(body).toContain(
      '> "can you pull this? https://example.com/article"',
    );
    expect(body).toContain("Will run: `GET https://example.com/article`");
    expect(body).toContain(
      "[View in Slack →](https://slack.com/archives/C01ABC/p1700000000000100)",
    );
  });

  test("metadata carries the tool and a resolved Slack source", () => {
    const { metadata } = surfaceOf(
      buildToolApprovalSeedContentBlocks(slackChannelGrant)!,
    ).data;
    expect(metadata).toContainEqual({ label: "Tool", value: "web_fetch" });
    expect(metadata).toContainEqual({
      label: "Source",
      value: "Slack — #general",
    });
  });

  test("approve/reject actions are wired to the request id", () => {
    const surface = surfaceOf(
      buildToolApprovalSeedContentBlocks(slackChannelGrant)!,
    );
    expect(surface.actions).toEqual([
      {
        id: "apr:req-grant-1:approve_once",
        label: "Approve",
        style: "primary",
      },
      { id: "apr:req-grant-1:reject", label: "Reject", style: "destructive" },
    ]);
  });

  test("text fallback reuses the one-line phrasing + request-code instruction", () => {
    const { text } = textOf(
      buildToolApprovalSeedContentBlocks(slackChannelGrant)!,
    );
    expect(text).toContain('Assistant wants to use "web_fetch"');
    expect(text).toContain("in response to Noa Flaherty's message in #general");
    expect(text).toContain("XYZ789");
    expect(text).toContain("approve");
  });

  // ── Connective branch: DM (drop the channel) ───────────────────────────────
  test("DM source: subtitle drops the channel; source reads Direct message", () => {
    const surface = surfaceOf(
      buildToolApprovalSeedContentBlocks({
        ...slackChannelGrant,
        conversationExternalId: "D01XYZ",
        channelName: undefined,
      })!,
    );
    expect(surface.data.subtitle).toBe("in response to Noa Flaherty's message");
    expect(surface.data.metadata).toContainEqual({
      label: "Source",
      value: "Slack — Direct message",
    });
  });

  // ── Connective branch: no inbound trigger (self / scheduled) ────────────────
  test("no requester: falls back to a generic subtitle, no connective", () => {
    const surface = surfaceOf(
      buildToolApprovalSeedContentBlocks({
        requestId: "req-self-1",
        requestCode: "AAA111",
        requestKind: "tool_approval",
        toolName: "bash",
        questionText: 'Assistant wants to use "bash".',
        sourceChannel: "slack",
      })!,
    );
    expect(surface.data.title).toBe('Assistant wants to use "bash"');
    expect(surface.data.subtitle).toBe("Requesting approval to run this tool");
  });

  // ── Connective branch: voice (caller, but no "message") ─────────────────────
  test("voice (pending_question, phone): generic subtitle, no permalink", () => {
    const { data } = surfaceOf(
      buildToolApprovalSeedContentBlocks({
        requestId: "req-voice-1",
        requestCode: "VOICE1",
        requestKind: "pending_question",
        toolName: "bash",
        questionText: 'Assistant wants to use "bash".',
        sourceChannel: "phone",
        requesterIdentifier: "Bob",
      })!,
    );
    expect(data.subtitle).toBe("Requesting approval to run this tool");
    expect(data.metadata).toContainEqual({ label: "Tool", value: "bash" });
    expect(data.metadata).toContainEqual({ label: "Source", value: "phone" });
  });

  test("returns null for pending_question without a tool", () => {
    expect(
      buildToolApprovalSeedContentBlocks({
        requestId: "x",
        requestCode: "y",
        requestKind: "pending_question",
        questionText: "q",
      }),
    ).toBeNull();
  });
});
