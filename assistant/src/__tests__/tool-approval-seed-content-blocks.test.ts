import { describe, expect, test } from "bun:test";

import { buildToolApprovalSeedContentBlocks } from "../notifications/approval-card-data.js";

type Block = Record<string, unknown>;

function surfaceOf(blocks: unknown[]): Block {
  return blocks[0] as Block;
}
function dataOf(blocks: unknown[]): Block {
  return (blocks[0] as Block).data as Block;
}
function textOf(blocks: unknown[]): Block {
  return blocks[1] as Block;
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
    expect(surfaceOf(blocks).type).toBe("ui_surface");
    expect(surfaceOf(blocks).surfaceType).toBe("card");
    expect(surfaceOf(blocks).surfaceId).toBe("tool-approval-req-grant-1");
    expect(textOf(blocks).type).toBe("text");
    expect(textOf(blocks)._surfaceFallback).toBe(true);
  });

  test("primary line is the assistant-as-actor title, not the contact", () => {
    const data = dataOf(buildToolApprovalSeedContentBlocks(slackChannelGrant)!);
    expect(data.title).toBe('Assistant wants to use "web_fetch"');
    expect(data.title).not.toContain("Noa");
    // Generic category header lives in surface.title, not the contact's name.
    expect(
      surfaceOf(buildToolApprovalSeedContentBlocks(slackChannelGrant)!).title,
    ).toBe("Tool approval");
  });

  test("channel message: subtitle attributes the sender + channel", () => {
    const data = dataOf(buildToolApprovalSeedContentBlocks(slackChannelGrant)!);
    expect(data.subtitle).toBe(
      "in response to Noa Flaherty's message in #general",
    );
  });

  test("body shows the requester's words, the command, and a Slack link", () => {
    const data = dataOf(buildToolApprovalSeedContentBlocks(slackChannelGrant)!);
    const body = data.body as string;
    expect(body).toContain(
      '> "can you pull this? https://example.com/article"',
    );
    expect(body).toContain("Will run: `GET https://example.com/article`");
    expect(body).toContain(
      "[View in Slack →](https://slack.com/archives/C01ABC/p1700000000000100)",
    );
  });

  test("metadata carries the tool and a resolved Slack source", () => {
    const metadata = dataOf(
      buildToolApprovalSeedContentBlocks(slackChannelGrant)!,
    ).metadata as Array<{ label: string; value: string }>;
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
    const text = textOf(buildToolApprovalSeedContentBlocks(slackChannelGrant)!)
      .text as string;
    expect(text).toContain('Assistant wants to use "web_fetch"');
    expect(text).toContain("in response to Noa Flaherty's message in #general");
    expect(text).toContain("XYZ789");
    expect(text).toContain("approve");
  });

  // ── Connective branch: DM (drop the channel) ───────────────────────────────
  test("DM source: subtitle drops the channel; source reads Direct message", () => {
    const blocks = buildToolApprovalSeedContentBlocks({
      ...slackChannelGrant,
      conversationExternalId: "D01XYZ",
      channelName: undefined,
    })!;
    expect(dataOf(blocks).subtitle).toBe(
      "in response to Noa Flaherty's message",
    );
    const metadata = dataOf(blocks).metadata as Array<{
      label: string;
      value: string;
    }>;
    expect(metadata).toContainEqual({
      label: "Source",
      value: "Slack — Direct message",
    });
  });

  // ── Connective branch: no inbound trigger (self / scheduled) ────────────────
  test("no requester: falls back to a generic subtitle, no connective", () => {
    const blocks = buildToolApprovalSeedContentBlocks({
      requestId: "req-self-1",
      requestCode: "AAA111",
      requestKind: "tool_approval",
      toolName: "bash",
      questionText: 'Assistant wants to use "bash".',
      sourceChannel: "slack",
    })!;
    expect(dataOf(blocks).title).toBe('Assistant wants to use "bash"');
    expect(dataOf(blocks).subtitle).toBe(
      "Requesting approval to run this tool",
    );
  });

  // ── Connective branch: voice (caller, but no "message") ─────────────────────
  test("voice (pending_question, phone): generic subtitle, no permalink", () => {
    const blocks = buildToolApprovalSeedContentBlocks({
      requestId: "req-voice-1",
      requestCode: "VOICE1",
      requestKind: "pending_question",
      toolName: "bash",
      questionText: 'Assistant wants to use "bash".',
      sourceChannel: "phone",
      requesterIdentifier: "Bob",
    })!;
    expect(dataOf(blocks).subtitle).toBe(
      "Requesting approval to run this tool",
    );
    const metadata = dataOf(blocks).metadata as Array<{
      label: string;
      value: string;
    }>;
    expect(metadata).toContainEqual({ label: "Tool", value: "bash" });
    expect(metadata).toContainEqual({ label: "Source", value: "phone" });
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
