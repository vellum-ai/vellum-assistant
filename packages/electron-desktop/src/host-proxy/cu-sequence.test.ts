import { describe, expect, test } from "bun:test";
import { createCuHelperProxyExecutor, cuExecutorConfig } from "./cu-executor";

const build = (supportsSequence: boolean | undefined, toolName = "computer_use_sequence") =>
  cuExecutorConfig({
    logger: { info() {}, warn() {}, error() {} },
    resolveHelper: () => { throw new Error("not called"); },
    supportsSequence,
  }).buildParams(
    { type: "host_cu_request", toolName, input: { actions: [{ action: "key", key: "cmd+n" }], reasoning: "r" } },
    "req",
  );

describe("batched actions", () => {
  test("fails closed on clients built without support", () => {
    expect(build(undefined)).toHaveProperty("error");
    expect(build(false)).toHaveProperty("error");
  });
  test("forwards the actions unchanged on supported clients", () => {
    expect(build(true)).toMatchObject({
      params: { toolName: "computer_use_sequence", input: { actions: [{ action: "key", key: "cmd+n" }] } },
    });
  });
  test("leaves single actions alone on clients without support", () => {
    expect(build(false, "computer_use_key")).not.toHaveProperty("error");
  });
});

describe("cancelling a request the helper is still running", () => {
  test("tells the helper to stop, not just drops the result", async () => {
    const calls: { method: string; params: unknown }[] = [];
    const executor = createCuHelperProxyExecutor({
      logger: { info() {}, warn() {}, error() {} },
      resolveHelper: () => ({
        call: async (method: string, params?: unknown) => {
          calls.push({ method, params });
          return {};
        },
      }),
      supportsSequence: true,
    });
    executor.handleCancel({ type: "host_cu_cancel", requestId: "req-1" }, {} as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([{ method: "cu.cancel", params: { requestId: "req-1" } }]);
  });

  test("an older helper without cu.cancel is tolerated", async () => {
    const warnings: string[] = [];
    const executor = createCuHelperProxyExecutor({
      logger: { info() {}, warn: (m: string) => warnings.push(m), error() {} },
      resolveHelper: () => ({
        call: async () => {
          throw new Error("Method not found");
        },
      }),
    });
    executor.handleCancel({ type: "host_cu_cancel", requestId: "req-2" }, {} as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warnings.some((w) => w.includes("cu.cancel failed"))).toBe(true);
  });
});
