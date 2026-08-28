/**
 * Tests for the live-path guard in paths.ts: a test process must never
 * resolve the workspace or the gateway security directory to a directory
 * outside os.tmpdir().
 */

import { rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { getGatewaySecurityDir, getWorkspaceDir } from "../paths.js";

const originalWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
const originalSecurityDir = process.env.GATEWAY_SECURITY_DIR;
const originalAllowRealWorkspace =
  process.env.VELLUM_ALLOW_REAL_WORKSPACE_IN_TESTS;
const originalAllowRealSecurity =
  process.env.VELLUM_ALLOW_REAL_GATEWAY_SECURITY_IN_TESTS;

function restore(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

afterEach(() => {
  restore("VELLUM_WORKSPACE_DIR", originalWorkspaceDir);
  restore("GATEWAY_SECURITY_DIR", originalSecurityDir);
  restore("VELLUM_ALLOW_REAL_WORKSPACE_IN_TESTS", originalAllowRealWorkspace);
  restore(
    "VELLUM_ALLOW_REAL_GATEWAY_SECURITY_IN_TESTS",
    originalAllowRealSecurity,
  );
});

describe("live-path guard: workspace", () => {
  test("allows the preload's tmpdir workspace", () => {
    expect(getWorkspaceDir()).toBe(process.env.VELLUM_WORKSPACE_DIR!);
  });

  test("allows a not-yet-created nested path under tmpdir", () => {
    const dir = join(tmpdir(), "vellum-guard-nonexistent", "workspace");
    process.env.VELLUM_WORKSPACE_DIR = dir;
    expect(getWorkspaceDir()).toBe(dir);
  });

  test("refuses a non-tmpdir workspace in a test process", () => {
    delete process.env.VELLUM_ALLOW_REAL_WORKSPACE_IN_TESTS;
    process.env.VELLUM_WORKSPACE_DIR = join(homedir(), "vellum-guard-live");
    expect(() => getWorkspaceDir()).toThrow(/Refusing to use/);
  });

  test("refuses the ~/.vellum fallback when the env var is unset", () => {
    delete process.env.VELLUM_ALLOW_REAL_WORKSPACE_IN_TESTS;
    delete process.env.VELLUM_WORKSPACE_DIR;
    expect(() => getWorkspaceDir()).toThrow(/Refusing to use/);
  });

  test("VELLUM_ALLOW_REAL_WORKSPACE_IN_TESTS=1 bypasses the guard", () => {
    const dir = join(homedir(), "vellum-guard-live-optout");
    process.env.VELLUM_WORKSPACE_DIR = dir;
    process.env.VELLUM_ALLOW_REAL_WORKSPACE_IN_TESTS = "1";
    expect(getWorkspaceDir()).toBe(dir);
  });
});

describe("live-path guard: gateway security dir", () => {
  test("allows the preload's tmpdir security dir", () => {
    expect(getGatewaySecurityDir()).toBe(process.env.GATEWAY_SECURITY_DIR!);
  });

  test("refuses a non-tmpdir security dir in a test process", () => {
    delete process.env.VELLUM_ALLOW_REAL_GATEWAY_SECURITY_IN_TESTS;
    process.env.GATEWAY_SECURITY_DIR = join(homedir(), ".vellum", "protected");
    expect(() => getGatewaySecurityDir()).toThrow(/Refusing to use/);
  });

  test("refuses the ~/.vellum/protected fallback when the env var is unset", () => {
    delete process.env.VELLUM_ALLOW_REAL_GATEWAY_SECURITY_IN_TESTS;
    delete process.env.GATEWAY_SECURITY_DIR;
    expect(() => getGatewaySecurityDir()).toThrow(/Refusing to use/);
  });

  test("refuses a tmpdir symlink that resolves outside tmpdir", () => {
    delete process.env.VELLUM_ALLOW_REAL_GATEWAY_SECURITY_IN_TESTS;
    const link = join(tmpdir(), `vellum-guard-escape-${process.pid}`);
    rmSync(link, { force: true });
    symlinkSync(homedir(), link);
    try {
      process.env.GATEWAY_SECURITY_DIR = link;
      expect(() => getGatewaySecurityDir()).toThrow(/Refusing to use/);
    } finally {
      rmSync(link, { force: true });
    }
  });

  test("opt-out is per-call, not cached: same dir throws once the var clears", () => {
    const dir = join(homedir(), "vellum-guard-security-optout");
    process.env.GATEWAY_SECURITY_DIR = dir;
    process.env.VELLUM_ALLOW_REAL_GATEWAY_SECURITY_IN_TESTS = "1";
    expect(getGatewaySecurityDir()).toBe(dir);
    delete process.env.VELLUM_ALLOW_REAL_GATEWAY_SECURITY_IN_TESTS;
    expect(() => getGatewaySecurityDir()).toThrow(/Refusing to use/);
  });
});
