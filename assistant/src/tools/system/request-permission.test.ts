import { describe, expect, test } from "bun:test";

import type { ToolContext } from "../types.js";
import { requestSystemPermissionTool } from "./request-permission.js";

const ctx = (clientOS?: string): ToolContext =>
  ({ conversationId: "c", workingDir: "/", clientOS }) as ToolContext;

describe("request_system_permission", () => {
  test("uses Windows Settings URIs for Windows clients", async () => {
    const result = await requestSystemPermissionTool.execute(
      { permission_type: "camera" },
      ctx("windows"),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("ms-settings:privacy-webcam");
  });

  test("errors for kinds Windows does not gate", async () => {
    const result = await requestSystemPermissionTool.execute(
      { permission_type: "full_disk_access" },
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
