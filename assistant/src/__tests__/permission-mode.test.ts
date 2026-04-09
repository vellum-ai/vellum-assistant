import { describe, expect, test } from "bun:test";

import { PermissionsConfigSchema } from "../config/schemas/security.js";
import {
  DEFAULT_PERMISSION_MODE,
  PermissionModeSchema,
} from "../permissions/permission-mode.js";

describe("PermissionModeSchema", () => {
  test("parses empty object with the host-access default", () => {
    expect(PermissionModeSchema.parse({})).toEqual({ hostAccess: false });
  });

  test("DEFAULT_PERMISSION_MODE matches schema defaults", () => {
    expect(PermissionModeSchema.parse({})).toEqual(DEFAULT_PERMISSION_MODE);
  });

  test("accepts explicit host access values", () => {
    expect(PermissionModeSchema.parse({ hostAccess: true })).toEqual({
      hostAccess: true,
    });
    expect(PermissionModeSchema.parse({ hostAccess: false })).toEqual({
      hostAccess: false,
    });
  });

  test("round-trips through JSON serialization", () => {
    const original = { hostAccess: true };
    const json = JSON.stringify(original);
    expect(PermissionModeSchema.parse(JSON.parse(json))).toEqual(original);
  });

  test("rejects non-boolean hostAccess", () => {
    expect(() => PermissionModeSchema.parse({ hostAccess: "no" })).toThrow();
  });
});

describe("PermissionsConfigSchema", () => {
  test("defaults to workspace mode with host access disabled", () => {
    expect(PermissionsConfigSchema.parse({})).toEqual({
      mode: "workspace",
      hostAccess: false,
    });
  });

  test("preserves the mode field alongside hostAccess", () => {
    expect(PermissionsConfigSchema.parse({ mode: "strict" })).toEqual({
      mode: "strict",
      hostAccess: false,
    });
  });

  test("accepts overridden hostAccess values", () => {
    expect(
      PermissionsConfigSchema.parse({
        mode: "workspace",
        hostAccess: true,
      }),
    ).toEqual({
      mode: "workspace",
      hostAccess: true,
    });
  });

  test("round-trips hostAccess through JSON serialization", () => {
    const input = {
      mode: "workspace" as const,
      hostAccess: true,
    };
    const json = JSON.stringify(input);
    expect(PermissionsConfigSchema.parse(JSON.parse(json))).toEqual(input);
  });
});
