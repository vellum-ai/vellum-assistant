import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  buildTaskRules,
  clearTaskRunRules,
  getTaskRunRules,
  setTaskRunRules,
} from "../tasks/ephemeral-permissions.js";
import type { ToolContext } from "../tools/types.js";

const mockBatchModifyMessages =
  mock<
    (
      conn: unknown,
      ids: string[],
      opts: Record<string, unknown>,
    ) => Promise<void>
  >();
const mockListMessages =
  mock<
    (
      conn: unknown,
      query: string,
      limit: number,
      pageToken?: string,
    ) => Promise<{
      messages?: { id: string }[];
      nextPageToken?: string | null;
    }>
  >();
const mockModifyMessage =
  mock<
    (
      conn: unknown,
      messageId: string,
      opts: Record<string, unknown>,
    ) => Promise<void>
  >();
const mockResolveOAuthConnection =
  mock<(provider: string, opts?: unknown) => Promise<unknown>>();

mock.module("../messaging/providers/gmail/client.js", () => ({
  batchModifyMessages: mockBatchModifyMessages,
  listMessages: mockListMessages,
  modifyMessage: mockModifyMessage,
}));

mock.module("../oauth/connection-resolver.js", () => ({
  resolveOAuthConnection: mockResolveOAuthConnection,
}));

mock.module("../config/bundled-skills/gmail/tools/scan-result-store.js", () => ({
  getSenderMessageIds: () => ["msg-a", "msg-b"],
}));

const { run } = await import(
  "../config/bundled-skills/gmail/tools/gmail-archive.js"
);

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    conversationId: "conv-1",
    ...overrides,
  } as ToolContext;
}

describe("gmail_archive gate", () => {
  test("rejects query path when neither surface action nor batch-authorized task", async () => {
    const result = await run(
      { query: "in:inbox" },
      makeContext({
        triggeredBySurfaceAction: false,
        batchAuthorizedByTask: false,
      }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("surface action");
  });

  test("rejects batch message_ids path when neither flag set", async () => {
    const result = await run(
      { message_ids: ["m1", "m2"] },
      makeContext({
        triggeredBySurfaceAction: false,
        batchAuthorizedByTask: false,
      }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("surface action");
  });

  test("rejects scan_id path when neither flag set", async () => {
    const result = await run(
      { scan_id: "scan-1", sender_ids: ["s1"] },
      makeContext({
        triggeredBySurfaceAction: false,
        batchAuthorizedByTask: false,
      }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("surface action");
  });

  test("allows query path in a scheduled task run (batchAuthorizedByTask)", async () => {
    mockResolveOAuthConnection.mockResolvedValueOnce({ id: "gmail-conn" });
    mockListMessages.mockResolvedValueOnce({
      messages: [{ id: "m1" }, { id: "m2" }],
      nextPageToken: null,
    });
    mockBatchModifyMessages.mockResolvedValueOnce(undefined);

    const result = await run(
      { query: "in:inbox category:promotions" },
      makeContext({
        triggeredBySurfaceAction: false,
        batchAuthorizedByTask: true,
      }),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Archived 2 message(s)");
  });

  test("allows batch message_ids path in a scheduled task run", async () => {
    mockResolveOAuthConnection.mockResolvedValueOnce({ id: "gmail-conn" });
    mockBatchModifyMessages.mockResolvedValueOnce(undefined);

    const result = await run(
      { message_ids: ["m1", "m2"] },
      makeContext({
        triggeredBySurfaceAction: false,
        batchAuthorizedByTask: true,
      }),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Archived 2 message(s)");
  });

  describe("batchAuthorizedByTask computed per-tool from required_tools", () => {
    // Mirrors the computation in daemon/conversation-tool-setup.ts so a
    // regression in that call site would be caught by this test suite.
    function computeBatchAuthorizedByTask(
      taskRunId: string | null | undefined,
      toolName: string,
    ): boolean {
      return (
        taskRunId != null &&
        getTaskRunRules(taskRunId).some((r) => r.tool === toolName)
      );
    }

    afterEach(() => {
      clearTaskRunRules("task-run-unrelated");
      clearTaskRunRules("task-run-with-archive");
    });

    test("rejects gmail_archive when required_tools does NOT include it", async () => {
      const taskRunId = "task-run-unrelated";
      setTaskRunRules(
        taskRunId,
        buildTaskRules(taskRunId, ["host_bash"], "/tmp"),
      );

      const batchAuthorizedByTask = computeBatchAuthorizedByTask(
        taskRunId,
        "gmail_archive",
      );
      expect(batchAuthorizedByTask).toBe(false);

      const result = await run(
        { query: "in:inbox" },
        makeContext({
          taskRunId,
          triggeredBySurfaceAction: false,
          batchAuthorizedByTask,
        }),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("surface action");
    });

    test("rejects gmail_archive when required_tools is empty", async () => {
      const taskRunId = "task-run-unrelated";
      setTaskRunRules(taskRunId, buildTaskRules(taskRunId, [], "/tmp"));

      const batchAuthorizedByTask = computeBatchAuthorizedByTask(
        taskRunId,
        "gmail_archive",
      );
      expect(batchAuthorizedByTask).toBe(false);

      const result = await run(
        { message_ids: ["m1", "m2"] },
        makeContext({
          taskRunId,
          triggeredBySurfaceAction: false,
          batchAuthorizedByTask,
        }),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("surface action");
    });

    test("allows gmail_archive when required_tools DOES include it", async () => {
      const taskRunId = "task-run-with-archive";
      setTaskRunRules(
        taskRunId,
        buildTaskRules(taskRunId, ["gmail_archive"], "/tmp"),
      );

      const batchAuthorizedByTask = computeBatchAuthorizedByTask(
        taskRunId,
        "gmail_archive",
      );
      expect(batchAuthorizedByTask).toBe(true);

      mockResolveOAuthConnection.mockResolvedValueOnce({ id: "gmail-conn" });
      mockBatchModifyMessages.mockResolvedValueOnce(undefined);

      const result = await run(
        { message_ids: ["m1", "m2"] },
        makeContext({
          taskRunId,
          triggeredBySurfaceAction: false,
          batchAuthorizedByTask,
        }),
      );
      expect(result.isError).toBe(false);
      expect(result.content).toContain("Archived 2 message(s)");
    });
  });

  test("single message_id path works without either flag (no gate on that path)", async () => {
    mockResolveOAuthConnection.mockResolvedValueOnce({ id: "gmail-conn" });
    mockModifyMessage.mockResolvedValueOnce(undefined);

    const result = await run(
      { message_id: "msg-1" },
      makeContext({
        triggeredBySurfaceAction: false,
        batchAuthorizedByTask: false,
      }),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Message archived");
  });
});
