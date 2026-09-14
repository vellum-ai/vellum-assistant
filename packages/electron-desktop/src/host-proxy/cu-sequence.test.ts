import { describe, expect, test } from "bun:test";
import { cuExecutorConfig } from "./cu-executor";

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
