/**
 * The rider that lets a reloaded client re-raise the Connect card after a
 * mid-run Claude auth rejection.
 *
 * A pre-spawn rejection persists its classification on the failed `acp_spawn`
 * tool result. A mid-run one has no such result: the spawn succeeded and the
 * tool call completed clean, so the marker goes on the `tool_use` block that
 * spawned the run. These cover the matching and mutation rules; the database
 * shell around them is a lookup plus one write.
 */

import { describe, expect, test } from "bun:test";

import { ACP_CLAUDE_AUTH_REQUIRED_CODE } from "../api/events/acp-auth-required.js";
import {
  ACP_AUTH_ERROR_CODE_RIDER,
  applyAcpAuthRider,
  blocksCarryToolUse,
} from "./acp-auth-anchor-marker.js";

function toolUse(id: string, extra: Record<string, unknown> = {}) {
  return { type: "tool_use", id, name: "acp_spawn", input: {}, ...extra };
}

describe("blocksCarryToolUse", () => {
  test("finds the tool_use with the given id", () => {
    const blocks = [{ type: "text", text: "spawning" }, toolUse("tool-a")];
    expect(blocksCarryToolUse(blocks, "tool-a")).toBe(true);
  });

  test("ignores a tool_result that merely references the id", () => {
    const blocks = [
      { type: "tool_result", tool_use_id: "tool-a", content: "" },
    ];
    expect(blocksCarryToolUse(blocks, "tool-a")).toBe(false);
  });

  test("reports false for an unrelated turn", () => {
    expect(blocksCarryToolUse([toolUse("tool-b")], "tool-a")).toBe(false);
  });

  test("tolerates malformed blocks", () => {
    expect(blocksCarryToolUse([null, 7, "x", {}], "tool-a")).toBe(false);
  });
});

describe("applyAcpAuthRider", () => {
  test("stamps the auth code on the matching tool_use", () => {
    const blocks = [toolUse("tool-a")];
    expect(applyAcpAuthRider(blocks, "tool-a")).toBe(true);
    expect(
      (blocks[0] as Record<string, unknown>)[ACP_AUTH_ERROR_CODE_RIDER],
    ).toBe(ACP_CLAUDE_AUTH_REQUIRED_CODE);
  });

  test("leaves the spawn's own result fields untouched", () => {
    // The spawn succeeded; only the run failed. Nothing here may reclassify
    // the call itself as an error.
    const blocks = [toolUse("tool-a", { _startedAt: 42 })];
    applyAcpAuthRider(blocks, "tool-a");
    const rec = blocks[0] as Record<string, unknown>;
    expect(rec._startedAt).toBe(42);
    expect(rec.is_error).toBeUndefined();
  });

  test("is idempotent, so a repeat failure does not rewrite the row", () => {
    const blocks = [toolUse("tool-a")];
    expect(applyAcpAuthRider(blocks, "tool-a")).toBe(true);
    expect(applyAcpAuthRider(blocks, "tool-a")).toBe(false);
  });

  test("reports no change when the anchor is absent", () => {
    const blocks = [toolUse("tool-b")];
    expect(applyAcpAuthRider(blocks, "tool-a")).toBe(false);
    expect(
      (blocks[0] as Record<string, unknown>)[ACP_AUTH_ERROR_CODE_RIDER],
    ).toBeUndefined();
  });

  test("stamps only the anchor when a turn holds several tool calls", () => {
    const blocks = [toolUse("tool-a"), toolUse("tool-b"), toolUse("tool-c")];
    applyAcpAuthRider(blocks, "tool-b");
    const riders = blocks.map(
      (b) => (b as Record<string, unknown>)[ACP_AUTH_ERROR_CODE_RIDER],
    );
    expect(riders).toEqual([
      undefined,
      ACP_CLAUDE_AUTH_REQUIRED_CODE,
      undefined,
    ]);
  });
});
