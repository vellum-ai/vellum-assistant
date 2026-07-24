import { describe, expect, test } from "bun:test";

import type {
  ApprovalCardBlock,
  ApprovalCardFallbackBlock,
  ApprovalCardSurfaceBlock,
} from "../notifications/approval-card-builder.js";
import { buildToolApprovalSeedContentBlocks } from "../notifications/approval-card-data.js";

/**
 * Narrow the `[ui_surface, text]` pair through the discriminated union so
 * assertions read typed fields — a shape change in the block contract fails
 * compilation here instead of silently passing through a cast.
 */
function surfaceBlock(blocks: ApprovalCardBlock[]): ApprovalCardSurfaceBlock {
  const block = blocks[0];
  if (block?.type !== "ui_surface") {
    throw new Error("expected a ui_surface block first");
  }
  return block;
}

function fallbackBlock(blocks: ApprovalCardBlock[]): ApprovalCardFallbackBlock {
  const block = blocks[1];
  if (block?.type !== "text") {
    throw new Error("expected a text fallback block second");
  }
  return block;
}

describe("buildToolApprovalSeedContentBlocks", () => {
  const toolApprovalPayload: Record<string, unknown> = {
    requestId: "req-tool-456",
    requestCode: "XYZ789",
    requestKind: "tool_approval",
    toolName: "bash",
    questionText:
      "Approve tool: bash — mkdir -p scratch && assistant credentials reveal --service slack (requested by Bob)",
    sourceChannel: "slack",
    requesterIdentifier: "Bob",
  };

  const toolGrantPayload: Record<string, unknown> = {
    requestId: "req-grant-789",
    requestCode: "GHI012",
    requestKind: "tool_grant_request",
    toolName: "web_search",
    questionText:
      "Approve tool: web_search — search for latest news (requested by Alice)",
    sourceChannel: "telegram",
    requesterIdentifier: "Alice",
  };

  const voiceToolApprovalPayload: Record<string, unknown> = {
    requestId: "req-voice-101",
    requestCode: "VOICE1",
    requestKind: "pending_question",
    toolName: "bash",
    questionText: "Approve tool: bash — echo hello (requested by Bob)",
    sourceChannel: "phone",
    requesterIdentifier: "Bob",
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

  test("produces blocks for pending_question with toolName (voice tool approval)", () => {
    const blocks = buildToolApprovalSeedContentBlocks(
      voiceToolApprovalPayload,
    )!;
    expect(blocks).toHaveLength(2);
    const surface = surfaceBlock(blocks);
    expect(surface.surfaceType).toBe("card");
    expect(surface.surfaceId).toBe("tool-approval-req-voice-101");
    expect(surface.data.subtitle).toBe("Requires your approval to run");
    expect(surface.data.metadata).toContainEqual({
      label: "Requested by",
      value: "Bob",
    });
    expect(surface.data.metadata).toContainEqual({
      label: "Source",
      value: "phone",
    });
  });

  test("returns null for pending_question without toolName", () => {
    const payload = { ...voiceToolApprovalPayload, toolName: undefined };
    expect(buildToolApprovalSeedContentBlocks(payload)).toBeNull();
  });

  test("produces a ui_surface block and a text fallback block for tool_approval", () => {
    const blocks = buildToolApprovalSeedContentBlocks(toolApprovalPayload)!;
    expect(blocks).toHaveLength(2);
    surfaceBlock(blocks);
    // The fallback block is flagged so surface-capable clients skip it.
    expect(fallbackBlock(blocks)._surfaceFallback).toBe(true);
  });

  test("produces a ui_surface block and a text fallback block for tool_grant_request", () => {
    const blocks = buildToolApprovalSeedContentBlocks(toolGrantPayload)!;
    expect(blocks).toHaveLength(2);
    // The narrowing helpers throw unless the pair is [ui_surface, text].
    surfaceBlock(blocks);
    fallbackBlock(blocks);
  });

  test("card surface has correct surfaceType and surfaceId for tool_approval", () => {
    const surface = surfaceBlock(
      buildToolApprovalSeedContentBlocks(toolApprovalPayload)!,
    );
    expect(surface.surfaceType).toBe("card");
    expect(surface.surfaceId).toBe("tool-approval-req-tool-456");
    expect(surface.title).toBe("Tool Approval");
  });

  test("card surface has correct title for tool_grant_request", () => {
    const surface = surfaceBlock(
      buildToolApprovalSeedContentBlocks(toolGrantPayload)!,
    );
    expect(surface.title).toBe("Tool Grant Request");
  });

  test("card data uses the tool name as title — the decision is about the tool", () => {
    const surface = surfaceBlock(
      buildToolApprovalSeedContentBlocks(toolApprovalPayload)!,
    );
    expect(surface.data.title).toBe("bash");
  });

  test("requester appears only as metadata context, not as the card title", () => {
    const surface = surfaceBlock(
      buildToolApprovalSeedContentBlocks(toolApprovalPayload)!,
    );
    expect(surface.data.title).not.toBe("Bob");
    expect(surface.data.metadata).toContainEqual({
      label: "Requested by",
      value: "Bob",
    });
  });

  test("shows Requested by: Unknown when no requesterIdentifier", () => {
    const payload = { ...toolApprovalPayload, requesterIdentifier: undefined };
    const surface = surfaceBlock(buildToolApprovalSeedContentBlocks(payload)!);
    expect(surface.data.title).toBe("bash");
    expect(surface.data.metadata).toContainEqual({
      label: "Requested by",
      value: "Unknown",
    });

    // The plain-text fallback carries the same placeholder.
    const noQuestion = { ...payload, questionText: undefined };
    const fallback = fallbackBlock(
      buildToolApprovalSeedContentBlocks(noQuestion)!,
    );
    expect(fallback.text).toContain(
      "Approve tool: bash (requested by Unknown)",
    );
  });

  test("card subtitle is tool-framed for both tool_approval and tool_grant_request", () => {
    const approvalSurface = surfaceBlock(
      buildToolApprovalSeedContentBlocks(toolApprovalPayload)!,
    );
    const grantSurface = surfaceBlock(
      buildToolApprovalSeedContentBlocks(toolGrantPayload)!,
    );
    expect(approvalSurface.data.subtitle).toBe("Requires your approval to run");
    expect(grantSurface.data.subtitle).toBe("Requires your approval to run");
  });

  test("includes requester and source channel in metadata", () => {
    const surface = surfaceBlock(
      buildToolApprovalSeedContentBlocks(toolApprovalPayload)!,
    );
    expect(surface.data.metadata).toContainEqual({
      label: "Requested by",
      value: "Bob",
    });
    expect(surface.data.metadata).toContainEqual({
      label: "Source",
      value: "slack",
    });
  });

  test("body includes questionText as blockquote", () => {
    const surface = surfaceBlock(
      buildToolApprovalSeedContentBlocks(toolApprovalPayload)!,
    );
    expect(surface.data.body).toContain("Approve tool: bash");
    expect(surface.data.body).toContain("requested by Bob");
  });

  test("Slack DM source reference renders a permalink and rich source row", () => {
    const payload = {
      ...toolApprovalPayload,
      sourceChatId: "D01XYZ",
      sourceLink: {
        webUrl: "https://slack.com/archives/D01XYZ/p1700000000000100",
      },
    };
    const surface = surfaceBlock(buildToolApprovalSeedContentBlocks(payload)!);
    expect(surface.data.body).toContain(
      "[View message](https://slack.com/archives/D01XYZ/p1700000000000100)",
    );
    expect(surface.data.metadata).toContainEqual({
      label: "Source",
      value: "Slack — Direct message",
    });
  });

  test("Slack channel source renders a #channel source row", () => {
    const payload = {
      ...toolApprovalPayload,
      sourceChatId: "C01ABC",
      sourceLink: {
        webUrl: "https://slack.com/archives/C01ABC/p1700000001000200",
      },
    };
    const surface = surfaceBlock(buildToolApprovalSeedContentBlocks(payload)!);
    expect(surface.data.body).toContain(
      "[View message](https://slack.com/archives/C01ABC/p1700000001000200)",
    );
    expect(surface.data.metadata).toContainEqual({
      label: "Source",
      value: "Slack — #C01ABC",
    });
  });

  test("Slack source falls back to requesterChatId and omits the link without one", () => {
    const payload = {
      ...toolApprovalPayload,
      requesterChatId: "D0OTHER",
    };
    const surface = surfaceBlock(buildToolApprovalSeedContentBlocks(payload)!);
    expect(surface.data.body).not.toContain("[View message]");
    expect(surface.data.metadata).toContainEqual({
      label: "Source",
      value: "Slack — Direct message",
    });
  });

  test("non-Slack sources keep the plain channel row but still render a resolved link", () => {
    const payload = {
      ...toolGrantPayload,
      sourceChatId: "chat-123",
      sourceLink: { webUrl: "https://example.com/messages/42" },
    };
    const surface = surfaceBlock(buildToolApprovalSeedContentBlocks(payload)!);
    expect(surface.data.metadata).toContainEqual({
      label: "Source",
      value: "telegram",
    });
    expect(surface.data.body).toContain(
      "[View message](https://example.com/messages/42)",
    );
  });

  test("body shows fallback when no questionText", () => {
    const payload = { ...toolApprovalPayload, questionText: undefined };
    const surface = surfaceBlock(buildToolApprovalSeedContentBlocks(payload)!);
    expect(surface.data.body).toBe("No additional context available.");
  });

  test("surface block includes approve/reject actions when requestId present", () => {
    const surface = surfaceBlock(
      buildToolApprovalSeedContentBlocks(toolApprovalPayload)!,
    );
    expect(surface.actions).toHaveLength(2);
    expect(surface.actions?.[0]).toEqual({
      id: "apr:req-tool-456:approve_once",
      label: "Approve",
      style: "primary",
    });
    expect(surface.actions?.[1]).toEqual({
      id: "apr:req-tool-456:reject",
      label: "Reject",
      style: "destructive",
    });
  });

  test("surface block omits actions when requestId is missing", () => {
    const payload = { ...toolApprovalPayload, requestId: undefined };
    const surface = surfaceBlock(buildToolApprovalSeedContentBlocks(payload)!);
    expect(surface.actions).toBeUndefined();
  });

  test("text fallback block contains questionText and request-code instruction", () => {
    const fallback = fallbackBlock(
      buildToolApprovalSeedContentBlocks(toolApprovalPayload)!,
    );
    expect(fallback.text).toContain("Approve tool: bash");
    expect(fallback.text).toContain("XYZ789");
    expect(fallback.text).toContain("approve");
  });

  test("text fallback block omits request-code instruction when no requestCode", () => {
    const payload = { ...toolApprovalPayload, requestCode: undefined };
    const fallback = fallbackBlock(
      buildToolApprovalSeedContentBlocks(payload)!,
    );
    expect(fallback.text).toContain("Approve tool: bash");
    expect(fallback.text).not.toContain("XYZ789");
  });

  test("text fallback block uses tool-framed generic text when no questionText", () => {
    const payload = { ...toolApprovalPayload, questionText: undefined };
    const fallback = fallbackBlock(
      buildToolApprovalSeedContentBlocks(payload)!,
    );
    expect(fallback.text).toContain("Approve tool: bash (requested by Bob)");
  });
});
