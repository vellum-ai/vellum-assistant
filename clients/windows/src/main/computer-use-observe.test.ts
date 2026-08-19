import { describe, expect, mock, test } from "bun:test";
import path from "node:path";

mock.module("electron", () => ({
  app: {
    isPackaged: false,
    getAppPath: () => "C:\\dev\\app",
    once: () => undefined,
  },
}));

mock.module("./logger", () => ({
  default: { info: () => undefined, warn: () => undefined },
}));

const { captureDisplay, getWindowsHelperPath, observeAutomation } =
  await import("./features/computer-use-observe");

describe("getWindowsHelperPath", () => {
  test("resolves the dev helper per architecture", () => {
    expect(getWindowsHelperPath("x64", false)).toContain(
      ["resources", "native-helper", "x64", "Vellum.WindowsHelper.exe"].join(
        path.sep,
      ),
    );
  });
});

describe("helper calls", () => {
  test("observe forwards params and parses the helper result", async () => {
    const call = mock(async () => ({
      kind: "full",
      tree: '{"id":"r1.2"}',
      foregroundApp: { name: "notepad", processId: 1234 },
      secondaryWindows: "[]",
    }));
    const result = await observeAutomation(
      { conversationId: "c1", mode: "diff" },
      { call },
    );
    expect(call).toHaveBeenCalledWith("automation.observe", {
      conversationId: "c1",
      mode: "diff",
    });
    expect(result.tree).toBe('{"id":"r1.2"}');
  });

  test("capture tolerates structured unavailable results", async () => {
    const call = mock(async () => ({
      unavailable: { code: "not_found", message: "no such display" },
    }));
    const result = await captureDisplay({ displayId: 9 }, { call });
    expect(call).toHaveBeenCalledWith("capture.display", { displayId: 9 });
    expect(result.unavailable?.code).toBe("not_found");
  });

  test("malformed helper results are rejected", async () => {
    const bad = { call: async () => ({ kind: "nonsense" }) };
    await expect(
      observeAutomation({ conversationId: "c1" }, bad),
    ).rejects.toThrow();
  });
});
