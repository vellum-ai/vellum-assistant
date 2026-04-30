import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { initGatewayDb, resetGatewayDb } from "../db/connection.js";

const originalSecurityDir = process.env.GATEWAY_SECURITY_DIR;
const originalAllowRealSecurity =
  process.env.VELLUM_ALLOW_REAL_GATEWAY_SECURITY_IN_TESTS;
const originalTestRealSecurity =
  process.env.VELLUM_TEST_REAL_GATEWAY_SECURITY_DIR;
const originalHome = process.env.HOME;

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

  if (originalTestRealSecurity === undefined) {
    delete process.env.VELLUM_TEST_REAL_GATEWAY_SECURITY_DIR;
  } else {
    process.env.VELLUM_TEST_REAL_GATEWAY_SECURITY_DIR =
      originalTestRealSecurity;
  }

  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
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

test("initGatewayDb refuses symlink aliases to the real security dir during tests", async () => {
  resetGatewayDb();
  const testRoot = realpathSync(
    mkdtempSync(join(tmpdir(), "vellum-gateway-db-isolation-")),
  );

  try {
    const fakeHome = join(testRoot, "home");
    const realSecurityDir = join(fakeHome, ".vellum", "protected");
    const aliasParent = join(testRoot, "aliases");
    const securityAlias = join(aliasParent, "gateway-security-link");

    mkdirSync(realSecurityDir, { recursive: true });
    mkdirSync(aliasParent, { recursive: true });
    symlinkSync(realSecurityDir, securityAlias, "dir");

    process.env.HOME = fakeHome;
    process.env.GATEWAY_SECURITY_DIR = securityAlias;
    process.env.VELLUM_TEST_REAL_GATEWAY_SECURITY_DIR = realSecurityDir;
    delete process.env.VELLUM_ALLOW_REAL_GATEWAY_SECURITY_IN_TESTS;

    await expect(initGatewayDb()).rejects.toThrow(
      "Refusing to open the real gateway security DB during tests",
    );
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("initGatewayDb refuses missing children under symlink aliases to the real security dir", async () => {
  resetGatewayDb();
  const testRoot = realpathSync(
    mkdtempSync(join(tmpdir(), "vellum-gateway-db-isolation-")),
  );

  try {
    const fakeHome = join(testRoot, "home");
    const realSecurityDir = join(fakeHome, ".vellum", "protected");
    const aliasParent = join(testRoot, "aliases");
    const securityLink = join(aliasParent, "gateway-security-link");
    const missingChild = join(securityLink, "new-security-dir");

    mkdirSync(realSecurityDir, { recursive: true });
    mkdirSync(aliasParent, { recursive: true });
    symlinkSync(realSecurityDir, securityLink, "dir");

    process.env.HOME = fakeHome;
    process.env.GATEWAY_SECURITY_DIR = missingChild;
    process.env.VELLUM_TEST_REAL_GATEWAY_SECURITY_DIR = realSecurityDir;
    delete process.env.VELLUM_ALLOW_REAL_GATEWAY_SECURITY_IN_TESTS;

    await expect(initGatewayDb()).rejects.toThrow(
      "Refusing to open the real gateway security DB during tests",
    );
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("initGatewayDb does not migrate legacy gateway DBs during tests", async () => {
  resetGatewayDb();
  const testRoot = realpathSync(
    mkdtempSync(join(tmpdir(), "vellum-gateway-db-isolation-")),
  );

  try {
    const fakeHome = join(testRoot, "home");
    const legacyDir = join(fakeHome, ".vellum", "data");
    const legacyDb = join(legacyDir, "gateway.sqlite");
    const securityDir = join(testRoot, "gateway-security");

    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(legacyDb, "legacy gateway db");

    process.env.HOME = fakeHome;
    process.env.GATEWAY_SECURITY_DIR = securityDir;
    delete process.env.VELLUM_ALLOW_REAL_GATEWAY_SECURITY_IN_TESTS;

    await initGatewayDb();

    expect(existsSync(legacyDb)).toBe(true);
    expect(existsSync(join(securityDir, "gateway.sqlite"))).toBe(true);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});
