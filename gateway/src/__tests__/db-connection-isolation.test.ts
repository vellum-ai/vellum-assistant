import { afterEach, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

import { initGatewayDb, resetGatewayDb } from "../db/connection.js";

const originalSecurityDir = process.env.GATEWAY_SECURITY_DIR;
const originalAllowRealSecurity =
  process.env.VELLUM_ALLOW_REAL_GATEWAY_SECURITY_IN_TESTS;

afterEach(() => {
  resetGatewayDb();
  if (originalSecurityDir === undefined) {
    delete process.env.GATEWAY_SECURITY_DIR;
  } else {
    process.env.GATEWAY_SECURITY_DIR = originalSecurityDir;
  }

  if (originalAllowRealSecurity === undefined) {
    delete process.env.VELLUM_ALLOW_REAL_GATEWAY_SECURITY_IN_TESTS;
  } else {
    process.env.VELLUM_ALLOW_REAL_GATEWAY_SECURITY_IN_TESTS =
      originalAllowRealSecurity;
  }
});

test("initGatewayDb refuses test runs without an isolated security dir", async () => {
  resetGatewayDb();
  delete process.env.GATEWAY_SECURITY_DIR;
  delete process.env.VELLUM_ALLOW_REAL_GATEWAY_SECURITY_IN_TESTS;

  await expect(initGatewayDb()).rejects.toThrow(
    "Refusing to open the gateway DB during tests without GATEWAY_SECURITY_DIR",
  );
});

test("initGatewayDb refuses the real security dir during tests even when explicitly set", async () => {
  resetGatewayDb();
  process.env.GATEWAY_SECURITY_DIR = join(homedir(), ".vellum", "protected");
  delete process.env.VELLUM_ALLOW_REAL_GATEWAY_SECURITY_IN_TESTS;

  await expect(initGatewayDb()).rejects.toThrow(
    "Refusing to open the real gateway security DB during tests",
  );
});
