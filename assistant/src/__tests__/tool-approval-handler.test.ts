import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  installThresholdReaderMock,
  resetThresholdReaderMock,
  thresholdReaderMock,
} from "./gateway-threshold-reader-mock.js";

const testDir = process.env.VELLUM_WORKSPACE_DIR!;

// Mock verification control-plane policy -- not targeting control-plane by default
mock.module("../tools/verification-control-plane-policy.js", () => ({
  enforceVerificationControlPlanePolicy: () => ({ denied: false }),
}));

// Mock task run rules — no task run rules by default
mock.module("../tasks/ephemeral-permissions.js", () => ({
  getTaskRunRules: () => [],
}));

// Mock tool registry — return a fake tool for 'bash'
const fakeTool = {
  name: "bash",
  description: "Run a shell command",
  category: "shell",
  defaultRiskLevel: "high",
  input_schema: {},
  execute: async () => ({ content: "ok", isError: false }),
};

/** Same tool class as `fakeTool`, but reaching the guardian's own machine. */
const fakeHostTool = {
  ...fakeTool,
  name: "host_bash",
  executionTarget: "host" as const,
};

/**
 * A skill shadowing a core side-effect name. A novel third-party tool name is
 * not a side-effect tool at all, so it never reaches the floor — shadowing is
 * the case where an unvetted manifest lands on a liftable invocation.
 */
const fakeSkillTool = {
  ...fakeTool,
  name: "document_create",
  category: "documents",
};

const fakeTools: Record<string, typeof fakeTool> = {
  bash: fakeTool,
  host_bash: fakeHostTool,
  document_create: fakeSkillTool,
  acme_send: { ...fakeTool, name: "acme_send", category: "messaging" },
  ws_deploy: { ...fakeTool, name: "ws_deploy", category: "workspace" },
  mcp_lookup: { ...fakeTool, name: "mcp_lookup", category: "mcp" },
  file_write: { ...fakeTool, name: "file_write", category: "filesystem" },
  web_fetch: { ...fakeTool, name: "web_fetch", category: "network" },
};

/** Registry ownership per tool — drives the extension-owned gate checks. */
const toolOwners: Record<string, { kind: string; id: string }> = {
  document_create: { kind: "skill", id: "some-skill" },
  acme_send: { kind: "skill", id: "some-skill" },
  ws_deploy: { kind: "workspace", id: "tools/ws-deploy.ts" },
  mcp_lookup: { kind: "mcp", id: "some-server" },
};

/**
 * Per-test owner override for `file_write`, for the workspace-override-of-a-
 * core-name case. `undefined` = unowned built-in, the lift tests' baseline.
 */
let fileWriteOwner: { kind: string; id: string } | undefined;

mock.module("../tools/registry.js", () => ({
  getTool: (name: string) => fakeTools[name],
  resolveTool: (name: string) => fakeTools[name],
  getAllTools: () => Object.values(fakeTools),
  getToolOwner: (name: string) =>
    name === "file_write" && fileWriteOwner ? fileWriteOwner : toolOwners[name],
}));

// Mock the dynamic-skill predicate so isSensitiveTool's skill_load branch is
// exercised without a real skill catalog: "dynamic-skill" is an inline-command
// load, anything else is plain.
/** Whether the owning skill of the tool under test reports as first-party. */
let skillOwnerBundled = false;

mock.module("../permissions/checker.js", () => ({
  isDynamicSkillLoadInvocation: (
    _name: string,
    input: Record<string, unknown>,
  ) => input?.skill === "dynamic-skill",
  isToolOwnerSkillBundled: () => skillOwnerBundled,
}));

// The channel permission-matrix cell is a gateway IPC call; the shared mock
// makes it per-test controllable and counts lookups.
installThresholdReaderMock();

// Capture tool-audit terminal calls so tests can assert on denied/error outcomes
// the way they previously asserted on emitted lifecycle events.
const auditCalls = {
  denied: [] as any[],
  error: [] as any[],
  executed: [] as any[],
  prompted: [] as string[],
};
mock.module("../telemetry/tool-audit.js", () => ({
  recordToolDenied: (e: any) => auditCalls.denied.push(e),
  recordToolError: (e: any) => auditCalls.error.push(e),
  recordToolExecuted: (e: any) => auditCalls.executed.push(e),
  recordToolPermissionPrompted: (n: string) => auditCalls.prompted.push(n),
}));

function resetAuditCalls(): void {
  auditCalls.denied.length = 0;
  auditCalls.error.length = 0;
  auditCalls.executed.length = 0;
  auditCalls.prompted.length = 0;
}

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  mintGrantFromDecision,
  type MintGrantParams,
} from "../approvals/approval-primitive.js";
import { getDb } from "../persistence/db-connection.js";
import { getSqlite } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { scopedApprovalGrants } from "../persistence/schema/index.js";
import { computeToolApprovalDigest } from "../security/tool-approval-digest.js";
import {
  type ApprovalCellThreshold,
  resolveSensitiveToolDecision,
  sensitiveToolReach,
  ToolApprovalHandler,
} from "../tools/tool-approval-handler.js";
import type { ToolContext } from "../tools/types.js";

await initializeDb();

function clearTables(): void {
  const db = getDb();
  db.delete(scopedApprovalGrants).run();
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
  const now = Date.now();
  getSqlite().run(
    "INSERT INTO conversations (id, created_at, updated_at) VALUES (?, ?, ?)",
    ["conv-1", now, now],
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mintParams(overrides: Partial<MintGrantParams> = {}): MintGrantParams {
  const futureExpiry = Date.now() + 60_000;
  return {
    scopeMode: "tool_signature",
    requestChannel: "telegram",
    decisionChannel: "telegram",
    expiresAt: futureExpiry,
    ...overrides,
  };
}

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: testDir,
    conversationId: "conv-1",
    assistantId: "self",
    requestId: "req-1",
    trustClass: "trusted_contact",
    ...overrides,
  };
}

// ===========================================================================
// TESTS
// ===========================================================================

describe("ToolApprovalHandler / pre-exec gate grant check", () => {
  const handler = new ToolApprovalHandler();

  beforeEach(() => {
    clearTables();
    resetAuditCalls();
  });

  test("untrusted actor + matching tool_signature grant -> allow", async () => {
    const toolName = "bash";
    const input = { command: "ls -la" };
    const digest = computeToolApprovalDigest(toolName, input);

    // Mint a grant that matches the invocation
    const mintResult = mintGrantFromDecision(
      mintParams({
        scopeMode: "tool_signature",
        toolName,
        inputDigest: digest,
      }),
    );
    expect(mintResult.ok).toBe(true);

    const context = makeContext({ trustClass: "trusted_contact" });
    const result = await handler.checkPreExecutionGates(
      toolName,
      input,
      context,
      "high",
      Date.now(),
    );

    expect(result.allowed).toBe(true);
    // No permission_denied should have been recorded
    expect(auditCalls.denied.length).toBe(0);
  });

  test("untrusted actor + no matching grant -> deny with guardian_approval_required", async () => {
    const toolName = "bash";
    const input = { command: "rm -rf /" };

    const context = makeContext({ trustClass: "unknown" });
    const result = await handler.checkPreExecutionGates(
      toolName,
      input,
      context,
      "high",
      Date.now(),
    );

    expect(result.allowed).toBe(false);
    if (result.allowed) {
      return;
    }
    expect(result.result.isError).toBe(true);
    expect(result.result.content).toContain("guardian approval");

    // A permission_denied should have been recorded
    expect(auditCalls.denied.length).toBe(1);
  });

  test("unverified_channel actor + matching grant -> allow", async () => {
    const toolName = "bash";
    const input = { command: "echo hello" };
    const digest = computeToolApprovalDigest(toolName, input);

    mintGrantFromDecision(
      mintParams({
        scopeMode: "tool_signature",
        toolName,
        inputDigest: digest,
      }),
    );

    const context = makeContext({ trustClass: "unknown" });
    const result = await handler.checkPreExecutionGates(
      toolName,
      input,
      context,
      "high",
      Date.now(),
    );

    expect(result.allowed).toBe(true);
  });

  test("unverified_channel actor + no grant -> deny", async () => {
    const toolName = "bash";
    const input = { command: "deploy" };

    const context = makeContext({ trustClass: "unknown" });
    const result = await handler.checkPreExecutionGates(
      toolName,
      input,
      context,
      "high",
      Date.now(),
    );

    expect(result.allowed).toBe(false);
    if (result.allowed) {
      return;
    }
    expect(result.result.content).toContain("verified channel identity");
  });

  test("grant is one-time: second invocation with same input denied", async () => {
    const toolName = "bash";
    const input = { command: "ls" };
    const digest = computeToolApprovalDigest(toolName, input);

    mintGrantFromDecision(
      mintParams({
        scopeMode: "tool_signature",
        toolName,
        inputDigest: digest,
      }),
    );

    const context = makeContext({ trustClass: "unknown" });

    // First invocation — should consume the grant and allow
    const first = await handler.checkPreExecutionGates(
      toolName,
      input,
      context,
      "high",
      Date.now(),
    );
    expect(first.allowed).toBe(true);

    // Second invocation — grant already consumed, should deny
    const second = await handler.checkPreExecutionGates(
      toolName,
      input,
      context,
      "high",
      Date.now(),
    );
    expect(second.allowed).toBe(false);
  });

  test("grant with mismatched input digest -> deny", async () => {
    const toolName = "bash";
    const grantInput = { command: "ls" };
    const invokeInput = { command: "rm -rf /" };
    const grantDigest = computeToolApprovalDigest(toolName, grantInput);

    mintGrantFromDecision(
      mintParams({
        scopeMode: "tool_signature",
        toolName,
        inputDigest: grantDigest,
      }),
    );

    const context = makeContext({ trustClass: "unknown" });
    const result = await handler.checkPreExecutionGates(
      toolName,
      invokeInput,
      context,
      "high",
      Date.now(),
    );

    expect(result.allowed).toBe(false);
  });

  test("expired grant -> deny", async () => {
    const toolName = "bash";
    const input = { command: "ls" };
    const digest = computeToolApprovalDigest(toolName, input);
    const pastExpiry = Date.now() - 60_000;

    mintGrantFromDecision(
      mintParams({
        scopeMode: "tool_signature",
        toolName,
        inputDigest: digest,
        expiresAt: pastExpiry,
      }),
    );

    const context = makeContext({ trustClass: "unknown" });
    const result = await handler.checkPreExecutionGates(
      toolName,
      input,
      context,
      "high",
      Date.now(),
    );

    expect(result.allowed).toBe(false);
  });

  test("guardian actor bypasses grant check entirely (no grant needed)", async () => {
    const toolName = "bash";
    const input = { command: "deploy" };

    // No grants minted at all
    const context = makeContext({ trustClass: "guardian" });
    const result = await handler.checkPreExecutionGates(
      toolName,
      input,
      context,
      "high",
      Date.now(),
    );

    // Guardian should pass through — the untrusted gate is not triggered
    expect(result.allowed).toBe(true);
  });

  test("guardian actor role (desktop) bypasses grant check", async () => {
    const toolName = "bash";
    const input = { command: "deploy" };

    const context = makeContext({ trustClass: "guardian" });
    const result = await handler.checkPreExecutionGates(
      toolName,
      input,
      context,
      "high",
      Date.now(),
    );

    expect(result.allowed).toBe(true);
  });

  test("grant with matching request_id scope -> allow", async () => {
    const toolName = "bash";
    const input = { command: "ls" };

    mintGrantFromDecision(
      mintParams({
        scopeMode: "request_id",
        requestId: "req-1",
      }),
    );

    const context = makeContext({
      trustClass: "trusted_contact",
      requestId: "req-1",
    });
    const result = await handler.checkPreExecutionGates(
      toolName,
      input,
      context,
      "high",
      Date.now(),
    );

    expect(result.allowed).toBe(true);
  });

  test("grant with context fields (conversationId) must match", async () => {
    const toolName = "bash";
    const input = { command: "ls" };
    const digest = computeToolApprovalDigest(toolName, input);

    mintGrantFromDecision(
      mintParams({
        scopeMode: "tool_signature",
        toolName,
        inputDigest: digest,
        conversationId: "conv-other",
      }),
    );

    // Context conversationId does not match the grant's conversationId
    const context = makeContext({
      trustClass: "unknown",
      conversationId: "conv-1",
    });
    const result = await handler.checkPreExecutionGates(
      toolName,
      input,
      context,
      "high",
      Date.now(),
    );

    expect(result.allowed).toBe(false);
  });

  test("non-voice channel denial is instant (no retry polling)", async () => {
    const toolName = "bash";
    const input = { command: "rm -rf /" };

    // executionChannel defaults to undefined (non-voice)
    const context = makeContext({
      trustClass: "unknown",
      executionChannel: "telegram",
    });

    const start = Date.now();
    const result = await handler.checkPreExecutionGates(
      toolName,
      input,
      context,
      "high",
      Date.now(),
    );
    const elapsed = Date.now() - start;

    expect(result.allowed).toBe(false);
    if (result.allowed) {
      return;
    }
    expect(result.result.content).toContain("guardian approval");
    // Non-voice denials should be nearly instant — no 10s retry polling
    expect(elapsed).toBeLessThan(500);
  });

  test("voice channel with delayed grant succeeds via retry polling", async () => {
    const toolName = "bash";
    const input = { command: "echo hello" };
    const digest = computeToolApprovalDigest(toolName, input);

    // Mint the grant after 300ms — the voice retry polling should find it
    setTimeout(() => {
      mintGrantFromDecision(
        mintParams({
          scopeMode: "tool_signature",
          toolName,
          inputDigest: digest,
        }),
      );
    }, 300);

    const context = makeContext({
      trustClass: "unknown",
      executionChannel: "phone",
    });

    const start = Date.now();
    const result = await handler.checkPreExecutionGates(
      toolName,
      input,
      context,
      "high",
      Date.now(),
    );
    const elapsed = Date.now() - start;

    expect(result.allowed).toBe(true);
    // Should have taken at least ~300ms (the minting delay) but not the full 10s
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(5_000);
  });

  test("voice channel abort returns Cancelled instead of guardian_approval_required", async () => {
    const toolName = "bash";
    const input = { command: "deploy --force" };

    const controller = new AbortController();
    // Abort after 200ms to simulate voice barge-in
    setTimeout(() => controller.abort(), 200);

    const context = makeContext({
      trustClass: "unknown",
      executionChannel: "phone",
      signal: controller.signal,
    });

    const start = Date.now();
    const result = await handler.checkPreExecutionGates(
      toolName,
      input,
      context,
      "high",
      Date.now(),
    );
    const elapsed = Date.now() - start;

    expect(result.allowed).toBe(false);
    if (result.allowed) {
      return;
    }
    // Should return 'Cancelled', not a guardian_approval_required message
    expect(result.result.content).toBe("Cancelled");
    expect(result.result.isError).toBe(true);
    // Should exit promptly after the abort signal, not wait full 10s
    expect(elapsed).toBeLessThan(2_000);

    // The recorded terminal should be an error with 'Cancelled', not a denial
    expect(auditCalls.error.length).toBeGreaterThanOrEqual(1);
    expect(auditCalls.denied.length).toBe(0);
    const lastError = auditCalls.error[auditCalls.error.length - 1];
    expect(lastError.errorMessage).toBe("Cancelled");
    expect(lastError.isExpected).toBe(true);
  });

  test("trusted contact requires grant for sandboxed side-effect tools", async () => {
    const result = await handler.checkPreExecutionGates(
      "bash",
      { command: "echo hello" },
      makeContext({ trustClass: "trusted_contact" }),
      "high",
      Date.now(),
    );

    expect(result.allowed).toBe(false);
    expect(auditCalls.denied).toHaveLength(1);
  });
});

describe("sensitiveToolReach", () => {
  test("reach is a property of the tool and execution target", () => {
    // Side-effect tools reach the sandbox wherever they run…
    expect(sensitiveToolReach("bash", "sandbox")).toBe("sandbox");
    expect(sensitiveToolReach("file_write", "sandbox")).toBe("sandbox");
    // …read-only tools reach only when they execute on the host…
    expect(sensitiveToolReach("web_search", "host")).toBe("host");
    expect(sensitiveToolReach("web_search", "sandbox")).toBe("none");
    // …and UI surface tools are exempt even on the host target.
    expect(sensitiveToolReach("ui_show", "host")).toBe("none");
    expect(sensitiveToolReach("ui_update", "host")).toBe("none");
    expect(sensitiveToolReach("ui_dismiss", "host")).toBe("none");
  });

  test("an inline-command (dynamic) skill_load reaches the host; a plain one is not sensitive", () => {
    // skill_load is not a side-effect tool, but a load that executes embedded
    // shell at load time must pass through the capability floor — so a
    // non-guardian's dynamic load escalates to the guardian, Full-access-proof.
    expect(
      sensitiveToolReach("skill_load", "sandbox", { skill: "dynamic-skill" }),
    ).toBe("host");
    expect(
      sensitiveToolReach("skill_load", "sandbox", { skill: "plain-skill" }),
    ).toBe("none");
    // Without input, skill_load falls back to the name/target rule.
    expect(sensitiveToolReach("skill_load", "sandbox")).toBe("none");
  });

  test("an out-of-workspace file_read reaches the host; an in-workspace one is not sensitive", () => {
    const workingDir = mkdtempSync(join(tmpdir(), "sensitive-tool-test-"));
    try {
      // Out-of-workspace file access is host-equivalent: the host-fallback
      // path policy executes the escape, so it carries the host capability
      // floor even for the read-only sandbox tool.
      expect(
        sensitiveToolReach(
          "file_read",
          "sandbox",
          { path: "/etc/hosts" },
          workingDir,
        ),
      ).toBe("host");
      expect(
        sensitiveToolReach(
          "file_read",
          "sandbox",
          { path: "notes.txt" },
          workingDir,
        ),
      ).toBe("none");
      // `path` is the executed field — a benign `file_path` must not mask it.
      expect(
        sensitiveToolReach(
          "file_read",
          "sandbox",
          { path: "/etc/hosts", file_path: "notes.txt" },
          workingDir,
        ),
      ).toBe("host");
      // Container-style /workspace paths remap to the workspace.
      expect(
        sensitiveToolReach(
          "file_read",
          "sandbox",
          { path: "/workspace/notes.txt" },
          workingDir,
        ),
      ).toBe("none");
      // Without a workingDir the boundary is unknown — name/target rule only.
      expect(
        sensitiveToolReach("file_read", "sandbox", { path: "/etc/hosts" }),
      ).toBe("none");
      // Containerized installs keep the hard execution boundary, so the
      // escape never executes and does not need the floor.
      process.env.IS_CONTAINERIZED = "true";
      try {
        expect(
          sensitiveToolReach(
            "file_read",
            "sandbox",
            { path: "/etc/hosts" },
            workingDir,
          ),
        ).toBe("none");
      } finally {
        delete process.env.IS_CONTAINERIZED;
      }
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
    }
  });
});

describe("resolveSensitiveToolDecision / CapabilitySet floor × approval cell", () => {
  const cellThresholds: Array<ApprovalCellThreshold | undefined> = [
    undefined,
    "none",
    "low",
    "medium",
    "high",
  ];
  /** The cells that authorize something, and so can lift the floor. */
  const liftingThresholds: ApprovalCellThreshold[] = ["low", "medium", "high"];

  test("no cell and a none cell both leave the escalate floor standing", () => {
    for (const cellThreshold of [undefined, "none"] as const) {
      expect(
        resolveSensitiveToolDecision({
          reach: "sandbox",
          cellThreshold,
          sensitiveToolApproval: "escalate-and-wait",
        }),
      ).toBe("escalate-and-wait");
    }
  });

  test("a cell that authorizes something lifts the escalate floor", () => {
    for (const cellThreshold of liftingThresholds) {
      expect(
        resolveSensitiveToolDecision({
          reach: "sandbox",
          cellThreshold,
          sensitiveToolApproval: "escalate-and-wait",
        }),
      ).toBe("proceed");
    }
  });

  // A room-level posture says what the assistant may do in that room. It is
  // never a grant of the owner's own machine or accounts, so no cell at any
  // cascade level reaches past the sandbox.
  test("host reach is never lifted, at any cell threshold", () => {
    for (const cellThreshold of cellThresholds) {
      expect(
        resolveSensitiveToolDecision({
          reach: "host",
          cellThreshold,
          sensitiveToolApproval: "escalate-and-wait",
        }),
      ).toBe("escalate-and-wait");
    }
  });

  // An actor with no established identity has no cell to stand on: the matrix
  // is keyed by contact type, and "unknown" is the absence of one. No cell at
  // any cascade level may turn that into permission to act.
  test("deny is absolute — no cell threshold lifts it", () => {
    for (const cellThreshold of cellThresholds) {
      for (const reach of ["sandbox", "host"] as const) {
        expect(
          resolveSensitiveToolDecision({
            reach,
            cellThreshold,
            sensitiveToolApproval: "deny",
          }),
        ).toBe("deny");
      }
    }
  });

  test("self capability proceeds for sensitive tools (lane-B policy governs downstream)", () => {
    for (const cellThreshold of cellThresholds) {
      for (const reach of ["sandbox", "host"] as const) {
        expect(
          resolveSensitiveToolDecision({
            reach,
            cellThreshold,
            sensitiveToolApproval: "self",
          }),
        ).toBe("proceed");
      }
    }
  });

  test("non-sensitive tools proceed regardless of the capability floor", () => {
    for (const sensitiveToolApproval of [
      "self",
      "escalate-and-wait",
      "deny",
    ] as const) {
      expect(
        resolveSensitiveToolDecision({
          reach: "none",
          cellThreshold: undefined,
          sensitiveToolApproval,
        }),
      ).toBe("proceed");
    }
  });
});

describe("ToolApprovalHandler / approval cell lifts the sensitive-tool floor", () => {
  const handler = new ToolApprovalHandler();
  /** An ordinary workspace write: sandbox reach, and nothing excludes it. */
  const toolName = "file_write";
  const input = { path: "notes/todo.md", content: "x" };

  /**
   * A contact in a room, with no `requesterExternalUserId` — escalation needs
   * one, so when the floor stands the gate takes the generic denial path
   * instead of reaching for the guardian-request machinery. That keeps these
   * tests on the gate's own decision.
   */
  function channelContext(overrides: Partial<ToolContext> = {}): ToolContext {
    return makeContext({
      trustClass: "trusted_contact",
      executionChannel: "telegram",
      channelPermissionChannelId: "C-room",
      ...overrides,
    });
  }

  function cell(threshold: string) {
    return { ok: true, resolved: { threshold, scope: "channel" } } as const;
  }

  beforeEach(() => {
    clearTables();
    resetAuditCalls();
    resetThresholdReaderMock();
    skillOwnerBundled = false;
    fileWriteOwner = undefined;
  });

  test.each(["low", "medium", "high"])(
    "a %s cell lifts the floor — no scoped grant required",
    async (threshold) => {
      thresholdReaderMock.cell = cell(threshold);

      const result = await handler.checkPreExecutionGates(
        toolName,
        input,
        channelContext(),
        "low",
        Date.now(),
      );

      expect(result.allowed).toBe(true);
      if (!result.allowed) {
        return;
      }
      // Not "approved via a grant" — the gate stepped out of the grant
      // mechanism entirely and handed off to the risk/threshold policy.
      expect(result.grantConsumed).toBeFalsy();
      expect(auditCalls.denied.length).toBe(0);
    },
  );

  test("a none cell authorizes nothing — the floor stands", async () => {
    thresholdReaderMock.cell = cell("none");

    const result = await handler.checkPreExecutionGates(
      toolName,
      input,
      channelContext(),
      "low",
      Date.now(),
    );

    expect(result.allowed).toBe(false);
    if (result.allowed) {
      return;
    }
    expect(result.result.content).toContain("requires guardian approval");
  });

  // Fail closed: an unreadable cell is indistinguishable from a strict one, so
  // a gateway outage must never widen what a channel actor may do.
  test("a failed cell lookup does not lift the floor", async () => {
    thresholdReaderMock.cell = { ok: false };

    const result = await handler.checkPreExecutionGates(
      toolName,
      input,
      channelContext(),
      "low",
      Date.now(),
    );

    expect(result.allowed).toBe(false);
  });

  // The matrix is keyed by contact type, and "unknown" is the absence of one.
  test("an unknown actor stays fail-closed even under a full-access cell", async () => {
    thresholdReaderMock.cell = cell("high");

    const result = await handler.checkPreExecutionGates(
      toolName,
      input,
      channelContext({ trustClass: "unknown" }),
      "low",
      Date.now(),
    );

    expect(result.allowed).toBe(false);
    if (result.allowed) {
      return;
    }
    expect(result.result.content).toContain("verified channel identity");
    // Nothing to resolve: no cell can lift an absolute deny.
    expect(thresholdReaderMock.cellLookups).toBe(0);
  });

  // The cell says what the assistant may do in a room, not what a contact may
  // do to the owner's machine. `host_bash` is the same tool class as `bash`
  // and the same Full-access cell — only the reach differs.
  test("a full-access cell does not lift a host-reach tool", async () => {
    thresholdReaderMock.cell = cell("high");

    const result = await handler.checkPreExecutionGates(
      "host_bash",
      { command: "ls" },
      channelContext(),
      "low",
      Date.now(),
    );

    expect(result.allowed).toBe(false);
    if (result.allowed) {
      return;
    }
    expect(result.result.content).toContain("requires guardian approval");
    // Host reach is decided before the cell matters, so nothing is looked up.
    expect(thresholdReaderMock.cellLookups).toBe(0);
  });

  // Each of these is a way back out of the sandbox, so a cell that lifted any
  // one of them would lift the others by the back door. Excluding only some
  // would read as safe while leaving the path open.
  describe("what no cell lifts, even at Full access", () => {
    beforeEach(() => {
      thresholdReaderMock.cell = cell("high");
    });

    async function expectFloored(
      toolName: string,
      toolInput: Record<string, unknown>,
    ) {
      const result = await handler.checkPreExecutionGates(
        toolName,
        toolInput,
        channelContext(),
        "low",
        Date.now(),
      );
      expect(result.allowed).toBe(false);
      if (result.allowed) {
        return;
      }
      expect(result.result.content).toContain("requires guardian approval");
      // Excluded before the cell matters, so nothing is looked up.
      expect(thresholdReaderMock.cellLookups).toBe(0);
    }

    // Running code in the workspace is how you write everything else in it.
    test("sandbox bash", async () => {
      await expectFloored("bash", { command: "ls" });
    });

    test.each([
      ["hooks", "hooks/on-message.ts"],
      ["plugins", "plugins/acme/register.ts"],
      ["skills", "skills/acme/SKILL.md"],
      ["tools", "tools/acme.ts"],
      ["routes", "routes/acme.ts"],
      ["workflows", "workflows/acme.ts"],
    ])("a write into %s/ — code the daemon runs later", async (_dir, path) => {
      await expectFloored("file_write", { path, content: "x" });
    });

    // Prompt surfaces are instructions the daemon obeys — rewriting them is
    // the same delegation as planting code, one layer up.
    test.each([
      ["the assistant's own instructions", "SOUL.md"],
      ["its identity", "IDENTITY.md"],
      ["a per-user context file", "users/someone.md"],
      ["a per-channel context file", "channels/general.md"],
      [
        "a system-section override",
        "prompts/system/10a-non-guardian-boundary.md",
      ],
    ])("a write to %s — %s", async (_label, path) => {
      await expectFloored("file_write", { path, content: "x" });
    });

    // Nothing reviewed an unvetted manifest, so the risk it claims about
    // itself must not be what decides whether a room may run it unattended.
    test("an unvetted skill shadowing a core side-effect tool", async () => {
      skillOwnerBundled = false;
      await expectFloored("document_create", { title: "x" });
    });

    // A novel name is in no side-effect list, so without the unvetted check it
    // would not be gated at all — the case the shadowing guard alone misses.
    test("an unvetted skill tool with a name of its own", async () => {
      skillOwnerBundled = false;
      await expectFloored("acme_send", { to: "someone" });
    });

    // Workspace-owned tools are dynamic-imported on-disk code with no
    // bundled tier — unvetted by definition, whatever the bundled flag says.
    test("a workspace-owned tool with a name of its own", async () => {
      skillOwnerBundled = true;
      await expectFloored("ws_deploy", { target: "prod" });
    });

    // A workspace tool registered over a delegable core name must not
    // inherit that name's liftability — the owner decides, not the name.
    test("a workspace override of a delegable core tool", async () => {
      fileWriteOwner = { kind: "workspace", id: "tools/file-write.ts" };
      await expectFloored("file_write", {
        path: "notes/todo.md",
        content: "x",
      });
    });

    // MCP tools are floored as host reach; this pins that the unvetted
    // allowlist catches them independently, so the floor does not hinge on
    // the host stamp alone.
    test("an MCP-owned tool, even without the host target", async () => {
      await expectFloored("mcp_lookup", { query: "q" });
    });

    // The private network is the guardian's machine: the daemon's own HTTP
    // surface, the gateway, whatever else is listening there.
    test("web_fetch reaching the private network", async () => {
      await expectFloored("web_fetch", {
        url: "http://localhost:7821/",
        allow_private_network: true,
      });
    });
  });

  test("a public web_fetch is still lifted", async () => {
    thresholdReaderMock.cell = cell("low");

    const result = await handler.checkPreExecutionGates(
      "web_fetch",
      { url: "https://example.com/" },
      channelContext(),
      "low",
      Date.now(),
    );

    expect(result.allowed).toBe(true);
  });

  // A successful cascade walk that finds no cell resolves the room's
  // default — Conservative — so an unconfigured room behaves exactly as the
  // picker and legend present it. (The mock's reset state IS the successful
  // no-cell resolution.)
  test("an unconfigured room lifts at the Conservative default", async () => {
    const result = await handler.checkPreExecutionGates(
      "file_write",
      { path: "notes/todo.md", content: "x" },
      channelContext(),
      "low",
      Date.now(),
    );

    expect(result.allowed).toBe(true);
    expect(thresholdReaderMock.cellLookups).toBe(1);
  });

  // The room default is the owner's global setting collapsed — a Strict
  // global yields Strict rooms, so nothing lifts.
  test("a Strict global keeps unconfigured rooms on the floor", async () => {
    thresholdReaderMock.roomDefault = "none";

    const result = await handler.checkPreExecutionGates(
      "file_write",
      { path: "notes/todo.md", content: "x" },
      channelContext(),
      "low",
      Date.now(),
    );

    expect(result.allowed).toBe(false);
  });

  // An unreadable global lifts nothing — the default derives from it, so
  // without it the floor stands.
  test("an unreadable global keeps unconfigured rooms on the floor", async () => {
    thresholdReaderMock.roomDefault = undefined;

    const result = await handler.checkPreExecutionGates(
      "file_write",
      { path: "notes/todo.md", content: "x" },
      channelContext(),
      "low",
      Date.now(),
    );

    expect(result.allowed).toBe(false);
  });

  // A write whose target cannot be resolved is never liftable — without a
  // workingDir the sink check cannot see where the write lands, and it must
  // fail closed rather than be skipped.
  test("a write with no workingDir stays floored at any cell", async () => {
    thresholdReaderMock.cell = cell("high");

    const result = await handler.checkPreExecutionGates(
      "file_write",
      { path: "hooks/evil.ts", content: "x" },
      channelContext({ workingDir: undefined }),
      "low",
      Date.now(),
    );

    expect(result.allowed).toBe(false);
    expect(thresholdReaderMock.cellLookups).toBe(0);
  });

  // The exclusions are about provenance and reach, not about naming: an
  // ordinary workspace write is still delegable.
  test("an ordinary workspace file write is still lifted", async () => {
    thresholdReaderMock.cell = cell("high");

    const result = await handler.checkPreExecutionGates(
      "file_write",
      { path: "notes/todo.md", content: "x" },
      channelContext(),
      "low",
      Date.now(),
    );

    expect(result.allowed).toBe(true);
    if (!result.allowed) {
      return;
    }
    expect(result.grantConsumed).toBeFalsy();
  });

  test("a bundled skill's side-effect tool is still lifted", async () => {
    thresholdReaderMock.cell = cell("high");
    skillOwnerBundled = true;

    const result = await handler.checkPreExecutionGates(
      "document_create",
      { title: "x" },
      channelContext(),
      "low",
      Date.now(),
    );

    expect(result.allowed).toBe(true);
  });

  test("a guardian never pays for the cell lookup", async () => {
    const result = await handler.checkPreExecutionGates(
      toolName,
      input,
      channelContext({ trustClass: "guardian" }),
      "low",
      Date.now(),
    );

    expect(result.allowed).toBe(true);
    expect(thresholdReaderMock.cellLookups).toBe(0);
  });

  test("a turn with no channel coordinates skips the lookup", async () => {
    const result = await handler.checkPreExecutionGates(
      toolName,
      input,
      makeContext({ trustClass: "trusted_contact" }),
      "low",
      Date.now(),
    );

    expect(result.allowed).toBe(false);
    expect(thresholdReaderMock.cellLookups).toBe(0);
  });
});

describe("ToolApprovalHandler / unparseable tool args gate", () => {
  const handler = new ToolApprovalHandler();

  beforeEach(() => {
    clearTables();
    resetAuditCalls();
  });

  test("input wrapped as { _raw } is rejected without executing", async () => {
    const result = await handler.checkPreExecutionGates(
      "bash",
      { _raw: '{"command": "ls -' },
      makeContext({ trustClass: "guardian" }),
      "low",
      Date.now(),
    );

    expect(result.allowed).toBe(false);
    if (result.allowed) {
      return;
    }
    expect(result.result.isError).toBe(true);
    expect(result.result.content).toContain("were not valid JSON");
    expect(result.result.content).toContain('{"command": "ls -');
    expect(result.result.content).toContain("Retry");

    expect(auditCalls.error).toHaveLength(1);
    expect(auditCalls.error[0].isExpected).toBe(true);
  });

  test("long raw args are truncated in the error message", async () => {
    const raw = `{"data": "${"x".repeat(500)}`;
    const result = await handler.checkPreExecutionGates(
      "bash",
      { _raw: raw },
      makeContext({ trustClass: "guardian" }),
      "low",
      Date.now(),
    );

    expect(result.allowed).toBe(false);
    if (result.allowed) {
      return;
    }
    expect(result.result.content).not.toContain(raw);
    expect(result.result.content).toContain("…");
  });

  test("legitimate input containing a _raw field among others is not rejected", async () => {
    const result = await handler.checkPreExecutionGates(
      "bash",
      { _raw: "something", command: "ls" },
      makeContext({ trustClass: "guardian" }),
      "low",
      Date.now(),
    );

    expect(result.allowed).toBe(true);
  });

  test("non-string _raw value is not treated as the marker", async () => {
    const result = await handler.checkPreExecutionGates(
      "bash",
      { _raw: 42 },
      makeContext({ trustClass: "guardian" }),
      "low",
      Date.now(),
    );

    expect(result.allowed).toBe(true);
  });
});

afterAll(() => {
  mock.restore();
});
