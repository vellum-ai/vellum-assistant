import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearPlatformToken,
  readPlatformToken,
  savePlatformToken,
} from "../lib/platform-client.js";

describe("platform-client token path is env-scoped", () => {
  let tempHome: string;
  let savedXdg: string | undefined;
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedXdg = process.env.XDG_CONFIG_HOME;
    savedEnv = process.env.VELLUM_ENVIRONMENT;
    tempHome = mkdtempSync(join(tmpdir(), "cli-platform-client-test-"));
    process.env.XDG_CONFIG_HOME = tempHome;
    delete process.env.VELLUM_ENVIRONMENT;
  });

  afterEach(() => {
    if (savedXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = savedXdg;
    }
    if (savedEnv === undefined) {
      delete process.env.VELLUM_ENVIRONMENT;
    } else {
      process.env.VELLUM_ENVIRONMENT = savedEnv;
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  test("prod (VELLUM_ENVIRONMENT unset) writes to $XDG_CONFIG_HOME/vellum/platform-token", () => {
    const token = "vak_prod_token_123";
    savePlatformToken(token);

    const prodPath = join(tempHome, "vellum", "platform-token");
    expect(existsSync(prodPath)).toBe(true);
    expect(readFileSync(prodPath, "utf-8").trim()).toBe(token);
    expect(readPlatformToken()).toBe(token);
  });

  test("dev (VELLUM_ENVIRONMENT=dev) writes to $XDG_CONFIG_HOME/vellum-dev/platform-token", () => {
    process.env.VELLUM_ENVIRONMENT = "dev";
    const token = "vak_dev_token_456";
    savePlatformToken(token);

    const devPath = join(tempHome, "vellum-dev", "platform-token");
    expect(existsSync(devPath)).toBe(true);
    expect(readFileSync(devPath, "utf-8").trim()).toBe(token);

    const prodPath = join(tempHome, "vellum", "platform-token");
    expect(existsSync(prodPath)).toBe(false);

    expect(readPlatformToken()).toBe(token);
  });

  test("prod and dev tokens are isolated on disk", () => {
    // Save prod token
    delete process.env.VELLUM_ENVIRONMENT;
    savePlatformToken("prod-token");

    // Switch to dev and save a different token
    process.env.VELLUM_ENVIRONMENT = "dev";
    savePlatformToken("dev-token");

    // Dev read returns dev
    expect(readPlatformToken()).toBe("dev-token");

    // Switch back to prod — prod value is unchanged
    delete process.env.VELLUM_ENVIRONMENT;
    expect(readPlatformToken()).toBe("prod-token");

    // Files live at distinct paths
    expect(
      readFileSync(join(tempHome, "vellum", "platform-token"), "utf-8").trim(),
    ).toBe("prod-token");
    expect(
      readFileSync(
        join(tempHome, "vellum-dev", "platform-token"),
        "utf-8",
      ).trim(),
    ).toBe("dev-token");
  });

  test("clearPlatformToken removes only the env-scoped token", () => {
    // Prod token
    delete process.env.VELLUM_ENVIRONMENT;
    savePlatformToken("prod-token");

    // Dev token
    process.env.VELLUM_ENVIRONMENT = "dev";
    savePlatformToken("dev-token");

    // Clear dev
    clearPlatformToken();
    expect(existsSync(join(tempHome, "vellum-dev", "platform-token"))).toBe(
      false,
    );

    // Prod still there
    expect(existsSync(join(tempHome, "vellum", "platform-token"))).toBe(true);
  });
});
