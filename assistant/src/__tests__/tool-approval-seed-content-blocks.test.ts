import { describe, expect, test } from "bun:test";

import { buildToolApprovalSeedContentBlocks } from "../notifications/tool-approval-copy.js";

describe("buildToolApprovalSeedContentBlocks", () => {
  const toolApprovalPayload: Record<string, unknown> = {
    requestId: "req-tool-456",
    requestCode: "XYZ789",
    requestKind: "tool_approval",
    toolName: "bash",
    questionText:
      'Bob wants to use "bash": mkdir -p scratch && assistant credentials reveal --service slack',
    sourceChannel: "slack",
    requesterIdentifier: "Bob",
  };

  const toolGrantPayload: Record<string, unknown> = {
    requestId: "req-grant-789",
    requestCode: "GHI012",
    requestKind: "tool_grant_request",
    toolName: "web_search",
    questionText: 'Alice wants to use "web_search": search for latest news',
    sourceChannel: "telegram",
    requesterIdentifier: "Alice",
  };

  const voiceToolApprovalPayload: Record<string, unknown> = {
    requestId: "req-voice-101",
    requestCode: "VOICE1",
    requestKind: "pending_question",
    toolName: "bash",
    questionText: 'Bob wants to use "bash": echo hello',
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
    expect((blocks[0] as Record<string, unknown>).type).toBe("ui_surface");
    const surface = blocks[0] as Record<string, unknown>;
    expect(surface.surfaceType).toBe("card");
    expect(surface.surfaceId).toBe("tool-approval-req-voice-101");
    const data = surface.data as Record<string, unknown>;
    expect(data.subtitle).toBe("Requesting approval to run this tool");
    const metadata = data.metadata as Array<{ label: string; value: string }>;
    expect(metadata).toContainEqual({ label: "Tool", value: "bash" });
    expect(metadata).toContainEqual({ label: "Source", value: "phone" });
  });

  test("returns null for pending_question without toolName", () => {
    const payload = { ...voiceToolApprovalPayload, toolName: undefined };
    expect(buildToolApprovalSeedContentBlocks(payload)).toBeNull();
  });

  test("produces a ui_surface block and a text fallback block for tool_approval", () => {
    const blocks = buildToolApprovalSeedContentBlocks(toolApprovalPayload)!;
    expect(blocks).toHaveLength(2);
    expect((blocks[0] as Record<string, unknown>).type).toBe("ui_surface");
    expect((blocks[1] as Record<string, unknown>).type).toBe("text");
  });

  test("produces a ui_surface block and a text fallback block for tool_grant_request", () => {
    const blocks = buildToolApprovalSeedContentBlocks(toolGrantPayload)!;
    expect(blocks).toHaveLength(2);
    expect((blocks[0] as Record<string, unknown>).type).toBe("ui_surface");
    expect((blocks[1] as Record<string, unknown>).type).toBe("text");
  });

  test("card surface has correct surfaceType and surfaceId for tool_approval", () => {
    const blocks = buildToolApprovalSeedContentBlocks(toolApprovalPayload)!;
    const surface = blocks[0] as Record<string, unknown>;
    expect(surface.surfaceType).toBe("card");
    expect(surface.surfaceId).toBe("tool-approval-req-tool-456");
    expect(surface.title).toBe("Tool Approval");
  });

  test("card surface has correct title for tool_grant_request", () => {
    const blocks = buildToolApprovalSeedContentBlocks(toolGrantPayload)!;
    const surface = blocks[0] as Record<string, unknown>;
    expect(surface.title).toBe("Tool Grant Request");
  });

  test("card data uses requesterIdentifier as title", () => {
    const blocks = buildToolApprovalSeedContentBlocks(toolApprovalPayload)!;
    const data = (blocks[0] as Record<string, unknown>).data as Record<
      string,
      unknown
    >;
    expect(data.title).toBe("Bob");
  });

  test("card data falls back to 'Someone' when no requesterIdentifier", () => {
    const payload = { ...toolApprovalPayload, requesterIdentifier: undefined };
    const blocks = buildToolApprovalSeedContentBlocks(payload)!;
    const data = (blocks[0] as Record<string, unknown>).data as Record<
      string,
      unknown
    >;
    expect(data.title).toBe("Someone");
  });

  test("card subtitle differs for tool_approval vs tool_grant_request", () => {
    const approvalBlocks =
      buildToolApprovalSeedContentBlocks(toolApprovalPayload)!;
    const grantBlocks = buildToolApprovalSeedContentBlocks(toolGrantPayload)!;
    const approvalData = (approvalBlocks[0] as Record<string, unknown>)
      .data as Record<string, unknown>;
    const grantData = (grantBlocks[0] as Record<string, unknown>)
      .data as Record<string, unknown>;
    expect(approvalData.subtitle).toBe("Requesting approval to run this tool");
    expect(grantData.subtitle).toBe("Requesting permission to use this tool");
  });

  test("includes tool name and source channel in metadata", () => {
    const blocks = buildToolApprovalSeedContentBlocks(toolApprovalPayload)!;
    const data = (blocks[0] as Record<string, unknown>).data as Record<
      string,
      unknown
    >;
    const metadata = data.metadata as Array<{ label: string; value: string }>;
    expect(metadata).toContainEqual({ label: "Tool", value: "bash" });
    expect(metadata).toContainEqual({ label: "Source", value: "slack" });
  });

  test("body includes questionText as blockquote", () => {
    const blocks = buildToolApprovalSeedContentBlocks(toolApprovalPayload)!;
    const data = (blocks[0] as Record<string, unknown>).data as Record<
      string,
      unknown
    >;
    expect(data.body).toContain("Bob wants to use");
    expect(data.body).toContain("bash");
  });

  test("body shows fallback when no questionText", () => {
    const payload = { ...toolApprovalPayload, questionText: undefined };
    const blocks = buildToolApprovalSeedContentBlocks(payload)!;
    const data = (blocks[0] as Record<string, unknown>).data as Record<
      string,
      unknown
    >;
    expect(data.body).toBe("No additional context available.");
  });

  test("surface block includes approve/reject actions when requestId present", () => {
    const blocks = buildToolApprovalSeedContentBlocks(toolApprovalPayload)!;
    const surface = blocks[0] as Record<string, unknown>;
    const actions = surface.actions as Array<{
      id: string;
      label: string;
      style: string;
    }>;
    expect(actions).toHaveLength(2);
    expect(actions[0]).toEqual({
      id: "apr:req-tool-456:approve_once",
      label: "Approve",
      style: "primary",
    });
    expect(actions[1]).toEqual({
      id: "apr:req-tool-456:reject",
      label: "Reject",
      style: "destructive",
    });
  });

  test("surface block omits actions when requestId is missing", () => {
    const payload = { ...toolApprovalPayload, requestId: undefined };
    const blocks = buildToolApprovalSeedContentBlocks(payload)!;
    const surface = blocks[0] as Record<string, unknown>;
    expect(surface.actions).toBeUndefined();
  });

  test("text fallback block contains questionText and request-code instruction", () => {
    const blocks = buildToolApprovalSeedContentBlocks(toolApprovalPayload)!;
    const textBlock = blocks[1] as Record<string, unknown>;
    expect(textBlock.type).toBe("text");
    expect(textBlock.text).toContain("Bob wants to use");
    expect(textBlock.text).toContain("XYZ789");
    expect(textBlock.text).toContain("approve");
  });

  test("text fallback block omits request-code instruction when no requestCode", () => {
    const payload = { ...toolApprovalPayload, requestCode: undefined };
    const blocks = buildToolApprovalSeedContentBlocks(payload)!;
    const textBlock = blocks[1] as Record<string, unknown>;
    expect(textBlock.text).toContain("Bob wants to use");
    expect(textBlock.text).not.toContain("XYZ789");
  });

  test("text fallback block uses generic text when no questionText", () => {
    const payload = { ...toolApprovalPayload, questionText: undefined };
    const blocks = buildToolApprovalSeedContentBlocks(payload)!;
    const textBlock = blocks[1] as Record<string, unknown>;
    expect(textBlock.text).toContain("requesting approval to use bash");
  });
});
