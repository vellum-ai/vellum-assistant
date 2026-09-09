/**
 * Permission behavior of `runToolStandalone`, the entry point behind
 * `assistant tools run`.
 *
 * The registry is real here, so tool ownership is too: an `mcp__*` tool
 * registered through `registerMcpTools` carries owner kind `mcp`, which is
 * what the sensitive-tool gate reads to decide that a tool is unvetted
 * extension code. Only the risk lane is stubbed, so what these tests exercise
 * is the trust context the runner builds.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  installThresholdReaderMock,
  resetThresholdReaderMock,
  thresholdReaderMock,
} from "../../__tests__/gateway-threshold-reader-mock.js";

/** Decision the stubbed permission check returns. */
let checkDecision: { decision: string; reason: string } = {
  decision: "allow",
  reason: "allowed",
};

// Only the two functions that reach the gateway are stubbed. The rest of the
// module is passed through by value, captured before the swap: `mock.module`
// replaces the module's exports in place, so reading them through the
// namespace inside the factory would resolve to this mock and recurse.
const realChecker = { ...(await import("../../permissions/checker.js")) };
mock.module("../../permissions/checker.js", () => ({
  ...realChecker,
  classifyRisk: async () => ({ level: "low" }),
  check: async () => checkDecision,
}));

installThresholdReaderMock();

const { registerMcpTools, registerTool } = await import("../registry.js");
const { runToolStandalone } = await import("../run-standalone.js");

/** A read-only, low-risk tool definition under `name`. */
function probeTool(name: string) {
  return {
    name,
    description: "read-only probe",
    input_schema: { type: "object", properties: {} },
    defaultRiskLevel: "low",
    executionTarget: "sandbox",
    execute: async () => ({ content: "PONG", isError: false }),
  } as never;
}

registerMcpTools("probe-server", [probeTool("mcp__probe__ping")]);
registerTool(probeTool("probe_core_ping"));

beforeEach(() => {
  resetThresholdReaderMock();
  checkDecision = { decision: "allow", reason: "allowed" };
});

describe("runToolStandalone", () => {
  test("runs an MCP tool the permission lane allows", async () => {
    const result = await runToolStandalone("mcp__probe__ping", {});

    expect(
      result,
      "An MCP tool is unvetted extension code, so the sensitive-tool gate " +
        "stops it unless the caller is trusted. The CLI caller is the " +
        "guardian; a non-guardian context denies every MCP, plugin and " +
        "non-bundled-skill tool, which is the whole set this path exists to " +
        "reach.",
    ).toMatchObject({ content: "PONG", isError: false });
  });

  test("runs a core tool the permission lane allows", async () => {
    expect(await runToolStandalone("probe_core_ping", {})).toMatchObject({
      content: "PONG",
      isError: false,
    });
  });

  test("denies a prompt decision instead of auto-approving it", async () => {
    checkDecision = { decision: "prompt", reason: "needs approval" };
    // A guardian threshold that would swallow this tool's risk whole. Without
    // `noApprovalChannel` the non-interactive guardian shortcut fires here and
    // the tool runs with nobody having approved it.
    thresholdReaderMock.threshold = "high";

    const result = await runToolStandalone("mcp__probe__ping", {});

    expect(result.isError).toBe(true);
    expect(result.content).toContain("no interactive client is connected");
    expect(result.content).not.toContain("PONG");
  });

  test("reads the headless threshold, not the autonomous one", async () => {
    checkDecision = { decision: "prompt", reason: "needs approval" };

    await runToolStandalone("mcp__probe__ping", {});

    const contexts = thresholdReaderMock.thresholdReads.map(
      (read) => read.executionContext,
    );
    expect(
      contexts,
      "The autonomous ceiling is what an owner sets for unattended work. A " +
        "command they typed and are waiting on is not that.",
    ).not.toContain("background");
    expect(contexts).toContain("headless");
  });
});
