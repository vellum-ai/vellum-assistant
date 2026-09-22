import { describe, expect, test } from "bun:test";
import { cuExecutorConfig } from "./cu-executor";

const config = (supported = true) => cuExecutorConfig({
  logger: { info() {}, warn() {}, error() {} },
  resolveHelper: () => { throw new Error("not called"); },
  supportsWindowCapture: supported,
});
const build = (input: Record<string, unknown>, supported = true, toolName = "computer_use_observe") =>
  config(supported).buildParams({ type: "host_cu_request", toolName, input }, "req");

describe("window-scoped observations", () => {
  test("maps public ID to the existing native key without mutating input", () => {
    const input = { capture_window_id: 4211 };
    expect(build(input)).toMatchObject({ params: { input: { captureWindowId: 4211 } } });
    expect(input).toEqual({ capture_window_id: 4211 });
  });
  test("leaves legacy requests unchanged", () => {
    expect(build({})).toMatchObject({ params: { input: {} } });
  });
  test("fails closed on unsupported clients", () => {
    expect(build({ capture_window_id: 1 }, false)).toHaveProperty("error");
  });
  test("rejects invalid native IDs", () => {
    for (const id of [0, -1, 1.5, "123", null, NaN, Infinity, 4294967296]) {
      expect(build({ capture_window_id: id })).toHaveProperty("error");
    }
  });
  test("rejects conflicting targets and action scope claims", () => {
    expect(build({ capture_window_id: 1, captureDisplayId: 2 })).toHaveProperty("error");
    expect(build({ capture_window_id: 1, captureWindowId: 2 })).toHaveProperty("error");
    expect(build({ capture_window_id: 1 }, true, "computer_use_click")).toHaveProperty("error");
  });
});
