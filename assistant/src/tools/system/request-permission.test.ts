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

  test("never hands a Linux client a macOS or Windows settings URL", async () => {
    for (const permission_type of [
      "screen_recording",
      "accessibility",
      "microphone",
      "camera",
      "full_disk_access",
      "calendar",
      "contacts",
      "photos",
      "location",
    ]) {
      const result = await requestSystemPermissionTool.execute(
        { permission_type },
        ctx("linux"),
      );
      expect(result.isError).toBe(true);
      expect(result.content).not.toContain("x-apple.systempreferences");
      expect(result.content).not.toContain("ms-settings:");
      expect(result.content).toContain("Linux");
    }
  });

  test("gives Linux clients a per-kind remediation", async () => {
    const screen = await requestSystemPermissionTool.execute(
      { permission_type: "screen_recording" },
      ctx("linux"),
    );
    expect(screen.content).toContain("desktop portal prompt");

    const accessibility = await requestSystemPermissionTool.execute(
      { permission_type: "accessibility" },
      ctx("linux"),
    );
    expect(accessibility.content).toContain("input group");
  });

  test("names the client OS in the unroutable message", async () => {
    const result = await requestSystemPermissionTool.execute(
      { permission_type: "camera" },
      ctx("windows"),
    );
    expect(result.content).toContain("on Windows");
    expect(result.content).toContain("Windows settings");
  });
});
