import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { ConfigFileCache } from "../config-file-cache.js";

let workspaceDir = "";

mock.module("../credential-reader.js", () => ({
  getWorkspaceDir: () => workspaceDir,
}));

mock.module("../logger.js", () => ({
  getLogger: () => ({
    error: () => {},
    info: () => {},
  }),
}));

const { startVelayTunnelOnGatewayBoot } = await import("./startup.js");

function writeConfig(data: Record<string, unknown>): void {
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(
    join(workspaceDir, "config.json"),
    JSON.stringify(data),
    "utf-8",
  );
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(workspaceDir, "config.json"), "utf-8"));
}

function makeConfigFileCache(invalidations: {
  count: number;
}): ConfigFileCache {
  return {
    invalidate: () => {
      invalidations.count++;
    },
  } as unknown as ConfigFileCache;
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "velay-startup-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("startVelayTunnelOnGatewayBoot", () => {
  test("starts Velay on gateway boot without requiring Twilio setup", async () => {
    const invalidations = { count: 0 };
    let starts = 0;
    writeConfig({
      ingress: {
        publicBaseUrl: "https://stale-velay.example.test",
        publicBaseUrlManagedBy: "velay",
      },
    });

    await startVelayTunnelOnGatewayBoot(
      {
        start: () => {
          starts++;
        },
      },
      makeConfigFileCache(invalidations),
    );

    expect(starts).toBe(1);
    expect(readConfig()).toEqual({ ingress: {} });
    expect(invalidations.count).toBe(1);
  });

  test("does nothing when Velay is not configured", async () => {
    const invalidations = { count: 0 };
    writeConfig({
      ingress: {
        publicBaseUrl: "https://manual.example.test",
      },
    });

    await startVelayTunnelOnGatewayBoot(
      undefined,
      makeConfigFileCache(invalidations),
    );

    expect(readConfig()).toEqual({
      ingress: {
        publicBaseUrl: "https://manual.example.test",
      },
    });
    expect(invalidations.count).toBe(0);
  });
});
