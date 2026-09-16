/**
 * Tests for the `acp_status` tool's live and persisted session projection.
 *
 * The session manager owns live process state. Completed sessions move to
 * durable history, where the status tool must keep them discoverable for
 * follow-up work without making internal lifecycle guards treat them as live.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { AcpSessionState } from "../../acp/types.js";
import type { ToolContext } from "../types.js";

const RUNNING_STATE: AcpSessionState = {
  id: "acp-1",
  agentId: "claude",
  acpSessionId: "proto-1",
  parentConversationId: "conv-1",
  status: "running",
  startedAt: 1234,
  task: "refactor the parser",
  model: "claude-opus-4-5",
  availableModels: [
    { value: "sonnet", label: "Sonnet" },
    { value: "opus", label: "Opus", description: "Most capable" },
  ],
};

let liveStates: AcpSessionState[] = [];
let fakeStoredCredential: string | undefined;

const realAcpModule = await import("../../acp/index.js");
mock.module("../../acp/index.js", () => ({
  ...realAcpModule,
  getAcpSessionManager: () => ({
    getStatus: () => liveStates,
    getBufferedUpdates: () => [],
  }),
}));

const realClaudeOauth = await import("../../acp/acp-claude-oauth.js");
mock.module("../../acp/acp-claude-oauth.js", () => ({
  ...realClaudeOauth,
  storedClaudeTokenDigest: async () => fakeStoredCredential,
}));

import {
  clearHistory,
  insertHistoryRow,
} from "../../acp/__tests__/helpers/acp-history-db.js";
import { claudeTokenDigest } from "../../acp/acp-auth-marker-store.js";
import { initializeDb } from "../../persistence/db-init.js";

const { executeAcpStatus } = await import("./status.js");

await initializeDb();

const context = {
  conversationId: "conv-1",
  workingDir: "/tmp",
} as unknown as ToolContext;

beforeEach(() => {
  liveStates = [];
  fakeStoredCredential = undefined;
  clearHistory();
});

describe("executeAcpStatus", () => {
  test("a live session reports its model but not the picker", async () => {
    liveStates = [RUNNING_STATE];

    const result = await executeAcpStatus({ acp_session_id: "acp-1" }, context);

    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content);
    expect(payload).toEqual({
      id: "acp-1",
      agentId: "claude",
      acpSessionId: "proto-1",
      parentConversationId: "conv-1",
      status: "running",
      startedAt: 1234,
      task: "refactor the parser",
      model: "claude-opus-4-5",
    });
    expect(result.content).not.toContain("Most capable");
  });

  test("a cleanly completed resumable session is returned as idle", async () => {
    insertHistoryRow({
      id: "completed-1",
      acpSessionId: "proto-completed-1",
      startedAt: 2000,
      completedAt: 3000,
      status: "completed",
      stopReason: "end_turn",
      cwd: "/tmp/project",
      task: "implement the parser",
      usedTokens: 1200,
      contextSize: 10000,
    });

    const result = await executeAcpStatus(
      { acp_session_id: "completed-1" },
      context,
    );

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual({
      id: "completed-1",
      agentId: "claude",
      acpSessionId: "proto-completed-1",
      parentConversationId: "conv-1",
      status: "idle",
      startedAt: 2000,
      completedAt: 3000,
      stopReason: "end_turn",
      task: "implement the parser",
      latestUsage: {
        usedTokens: 1200,
        contextSize: 10000,
      },
      resumable: true,
      lastRunStatus: "completed",
    });
  });

  test("failed and cancelled history rows keep their terminal status", async () => {
    insertHistoryRow({
      id: "failed-1",
      status: "failed",
      error: "adapter failed",
      cwd: "/tmp/project",
    });
    insertHistoryRow({
      id: "cancelled-1",
      status: "cancelled",
      stopReason: "cancelled",
      cwd: "/tmp/project",
    });

    const failed = await executeAcpStatus(
      { acp_session_id: "failed-1" },
      context,
    );
    const cancelled = await executeAcpStatus(
      { acp_session_id: "cancelled-1" },
      context,
    );

    expect(JSON.parse(failed.content)).toMatchObject({
      status: "failed",
      resumable: true,
      lastRunStatus: "failed",
      error: "adapter failed",
    });
    expect(JSON.parse(cancelled.content)).toMatchObject({
      status: "cancelled",
      resumable: true,
      lastRunStatus: "cancelled",
    });
  });

  test("a completed legacy row without cwd stays terminal", async () => {
    insertHistoryRow({ id: "legacy-1", status: "completed", cwd: null });

    const result = await executeAcpStatus(
      { acp_session_id: "legacy-1" },
      context,
    );

    expect(JSON.parse(result.content)).toMatchObject({
      status: "completed",
      resumable: false,
      lastRunStatus: "completed",
    });
  });

  test("a completed run stopped by cancellation stays terminal", async () => {
    insertHistoryRow({
      id: "partial-1",
      status: "completed",
      stopReason: "cancelled",
      cwd: "/tmp/project",
    });

    const result = await executeAcpStatus(
      { acp_session_id: "partial-1" },
      context,
    );

    expect(JSON.parse(result.content)).toMatchObject({
      status: "completed",
      resumable: true,
      lastRunStatus: "completed",
      stopReason: "cancelled",
    });
  });

  test("the listing includes live and persisted idle sessions", async () => {
    liveStates = [RUNNING_STATE];
    insertHistoryRow({
      id: "idle-1",
      startedAt: 2000,
      status: "completed",
      cwd: "/tmp/project",
    });

    const result = await executeAcpStatus({}, context);
    const payload = JSON.parse(result.content) as Array<
      Record<string, unknown>
    >;

    expect(payload.map((entry) => [entry.id, entry.status])).toEqual([
      ["idle-1", "idle"],
      ["acp-1", "running"],
    ]);
    for (const entry of payload) {
      expect(entry).not.toHaveProperty("availableModels");
      expect(entry).not.toHaveProperty("eventLog");
      expect(entry).not.toHaveProperty("cwd");
      expect(entry).not.toHaveProperty("source");
      expect(entry).not.toHaveProperty("authErrorCredential");
    }
  });

  test("live state wins over history for the same id", async () => {
    liveStates = [RUNNING_STATE];
    insertHistoryRow({
      id: RUNNING_STATE.id,
      status: "completed",
      cwd: "/tmp/project",
    });

    const result = await executeAcpStatus(
      { acp_session_id: RUNNING_STATE.id },
      context,
    );

    expect(JSON.parse(result.content)).toMatchObject({
      id: RUNNING_STATE.id,
      status: "running",
      agentId: RUNNING_STATE.agentId,
    });
  });

  test("a truly unknown id keeps the not-found error", async () => {
    const result = await executeAcpStatus(
      { acp_session_id: "missing-1" },
      context,
    );

    expect(result).toEqual({
      content: 'ACP session "missing-1" not found',
      isError: true,
    });
  });

  test("an empty listing says so rather than rendering an empty array", async () => {
    const result = await executeAcpStatus({}, context);

    expect(result.content).toBe("No ACP sessions found.");
    expect(result.isError).toBe(false);
  });

  test("withholds a persisted auth marker after the credential is replaced", async () => {
    const refused = claudeTokenDigest("sk-ant-oat-refused");
    insertHistoryRow({
      id: "auth-failed-1",
      status: "failed",
      error: "authentication required",
      cwd: "/tmp/project",
      authErrorCode: "acp_claude_auth_required",
      authErrorCredential: refused,
    });
    fakeStoredCredential = claudeTokenDigest("sk-ant-oat-replacement");

    const result = await executeAcpStatus(
      { acp_session_id: "auth-failed-1" },
      context,
    );

    expect(JSON.parse(result.content)).toMatchObject({
      id: "auth-failed-1",
      status: "failed",
      lastRunStatus: "failed",
    });
    expect(JSON.parse(result.content).authErrorCode).toBeUndefined();
    expect(result.content).not.toContain("authErrorCredential");
  });

  test("keeps a persisted auth marker while the refused credential is current", async () => {
    const refused = claudeTokenDigest("sk-ant-oat-refused");
    insertHistoryRow({
      id: "auth-failed-2",
      status: "failed",
      cwd: "/tmp/project",
      authErrorCode: "acp_claude_auth_required",
      authErrorCredential: refused,
    });
    fakeStoredCredential = refused;

    const result = await executeAcpStatus(
      { acp_session_id: "auth-failed-2" },
      context,
    );

    expect(JSON.parse(result.content)).toMatchObject({
      id: "auth-failed-2",
      status: "failed",
      authErrorCode: "acp_claude_auth_required",
    });
    expect(result.content).not.toContain("authErrorCredential");
  });

  test("keeps an older live session when 50 newer history rows exist", async () => {
    liveStates = [
      {
        ...RUNNING_STATE,
        id: "old-live",
        startedAt: 1,
      },
    ];
    for (let i = 0; i < 50; i++) {
      insertHistoryRow({
        id: `hist-${i}`,
        acpSessionId: `proto-hist-${i}`,
        startedAt: 1000 + i,
        status: "completed",
        cwd: "/tmp/project",
      });
    }

    const result = await executeAcpStatus({}, context);
    const payload = JSON.parse(result.content) as Array<{
      id: string;
      status: string;
    }>;

    expect(payload).toHaveLength(50);
    expect(payload.some((entry) => entry.id === "old-live")).toBe(true);
    expect(payload.find((entry) => entry.id === "old-live")?.status).toBe(
      "running",
    );
    expect(payload[0]?.id).toBe("hist-49");
    expect(payload.some((entry) => entry.id === "hist-0")).toBe(false);
  });
});
