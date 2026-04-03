import { describe, expect, test } from "bun:test";

import { PermissionsConfigSchema } from "../config/schemas/security.js";
import {
  DEFAULT_PERMISSION_MODE,
  PermissionModeSchema,
} from "../permissions/permission-mode.js";

// ---------------------------------------------------------------------------
// Tests: PermissionModeSchema
// ---------------------------------------------------------------------------

describe("PermissionModeSchema", () => {
  test("parses empty object with correct defaults", () => {
    const result = PermissionModeSchema.parse({});
    expect(result.askBeforeActing).toBe(true);
    expect(result.hostAccess).toBe(false);
  });

  test("DEFAULT_PERMISSION_MODE matches schema defaults", () => {
    const parsed = PermissionModeSchema.parse({});
    expect(parsed).toEqual(DEFAULT_PERMISSION_MODE);
  });

  test("accepts explicit true/true", () => {
    const result = PermissionModeSchema.parse({
      askBeforeActing: true,
      hostAccess: true,
    });
    expect(result.askBeforeActing).toBe(true);
    expect(result.hostAccess).toBe(true);
  });

  test("accepts explicit false/false", () => {
    const result = PermissionModeSchema.parse({
      askBeforeActing: false,
      hostAccess: false,
    });
    expect(result.askBeforeActing).toBe(false);
    expect(result.hostAccess).toBe(false);
  });

  test("round-trips through JSON serialization", () => {
    const original = { askBeforeActing: false, hostAccess: true };
    const json = JSON.stringify(original);
    const parsed = PermissionModeSchema.parse(JSON.parse(json));
    expect(parsed).toEqual(original);
  });

  test("rejects non-boolean askBeforeActing", () => {
    expect(() =>
      PermissionModeSchema.parse({ askBeforeActing: "yes" }),
    ).toThrow();
  });

  test("rejects non-boolean hostAccess", () => {
    expect(() => PermissionModeSchema.parse({ hostAccess: "no" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests: PermissionsConfigSchema (permissionMode fields)
// ---------------------------------------------------------------------------

describe("PermissionsConfigSchema permissionMode fields", () => {
  test("defaults askBeforeActing to true and hostAccess to false", () => {
    const result = PermissionsConfigSchema.parse({});
    expect(result.askBeforeActing).toBe(true);
    expect(result.hostAccess).toBe(false);
  });

  test("preserves existing mode field alongside new fields", () => {
    const result = PermissionsConfigSchema.parse({ mode: "strict" });
    expect(result.mode).toBe("strict");
    expect(result.askBeforeActing).toBe(true);
    expect(result.hostAccess).toBe(false);
  });

  test("accepts overridden values for new fields", () => {
    const result = PermissionsConfigSchema.parse({
      mode: "workspace",
      askBeforeActing: false,
      hostAccess: true,
    });
    expect(result.mode).toBe("workspace");
    expect(result.askBeforeActing).toBe(false);
    expect(result.hostAccess).toBe(true);
  });

  test("round-trips new fields through JSON serialization", () => {
    const input = {
      mode: "workspace" as const,
      askBeforeActing: false,
      hostAccess: true,
    };
    const json = JSON.stringify(input);
    const parsed = PermissionsConfigSchema.parse(JSON.parse(json));
    expect(parsed.askBeforeActing).toBe(false);
    expect(parsed.hostAccess).toBe(true);
  });
});
