import { describe, expect, mock, test } from "bun:test";

const recordToolInvocationMock = mock(() => {});

mock.module("../memory/tool-usage-store.js", () => ({
  recordToolInvocation: recordToolInvocationMock,
}));

const { runAction } = await import("./run-action.js");

describe("runAction", () => {
  test("emits started/executing/completed lifecycle and returns result", async () => {
    const lifecycle: string[] = [];
    const result = await runAction({
      actionName: "host_app_control.observe",
      conversationId: "conv-1",
      execute: async () => "ok",
      onLifecycle: (event) => {
        lifecycle.push(event.stage);
      },
    });

    expect(result).toBe("ok");
    expect(lifecycle).toEqual(["started", "executing", "completed"]);
    expect(recordToolInvocationMock).toHaveBeenCalledTimes(1);
  });

  test("emits failed + rollback stages when execute throws", async () => {
    const lifecycle: string[] = [];
    const executeError = new Error("boom");

    await expect(
      runAction({
        actionName: "host_app_control.click",
        conversationId: "conv-2",
        execute: async () => {
          throw executeError;
        },
        rollback: async () => undefined,
        onLifecycle: (event) => {
          lifecycle.push(event.stage);
        },
      }),
    ).rejects.toThrow("boom");

    expect(lifecycle).toEqual([
      "started",
      "executing",
      "failed",
      "rollback_started",
      "rollback_completed",
    ]);
    expect(recordToolInvocationMock).toHaveBeenCalledTimes(2);
  });
});
