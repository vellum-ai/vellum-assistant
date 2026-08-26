import { describe, expect, test } from "bun:test";

import type { ToolContext } from "../types.js";
import { requestSystemPermissionTool } from "./request-permission.js";

const ctx = (clientOs?: string): ToolContext =>
  ({ conversationId: "c", workingDir: "/", clientOs }) as ToolContext;

describe("request_system_permission", () => {
  test("uses Windows Settings URIs for Windows clients", async () => {
    const result = await requestSystemPermissionTool.execute(
      { permission_type: "microphone" },
      ctx("windows"),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("ms-settings:privacy-microphone");
  });

  test("errors for kinds the Windows client cannot route", async () => {
    const result = await requestSystemPermissionTool.execute(
      { permission_type: "camera" },
      ctx("windows"),
    );
    expect(result.isError).toBe(true);
  });

  test("defaults to macOS System Settings", async () => {
    const result = await requestSystemPermissionTool.execute(
      { permission_type: "camera" },
      ctx(),
    );
    expect(result.content).toContain("x-apple.systempreferences");
  });
});
