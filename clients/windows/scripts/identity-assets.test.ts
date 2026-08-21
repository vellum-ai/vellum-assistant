import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const requireCjs = createRequire(import.meta.url);
const windowsDir = path.resolve(import.meta.dir, "..");

const loadBuilderConfig = (environment: string) => {
  const configPath = requireCjs.resolve("../electron-builder.config.cjs");
  const previous = process.env.VELLUM_ENVIRONMENT;
  process.env.VELLUM_ENVIRONMENT = environment;
  delete requireCjs.cache[configPath];
  try {
    return requireCjs(configPath) as {
      win: { icon: string };
      nsis: { installerIcon: string; uninstallerIcon: string };
    };
  } finally {
    if (previous === undefined) {
      delete process.env.VELLUM_ENVIRONMENT;
    } else {
      process.env.VELLUM_ENVIRONMENT = previous;
    }
  }
};

const inspectIco = (
  relativePath: string,
): { dimensions: [number, number]; digest: string } => {
  const icon = readFileSync(path.join(windowsDir, relativePath));
  expect(icon.readUInt16LE(0)).toBe(0);
  expect(icon.readUInt16LE(2)).toBe(1);
  expect(icon.readUInt16LE(4)).toBeGreaterThan(0);
  return {
    dimensions: [icon[6] || 256, icon[7] || 256],
    digest: createHash("sha256").update(icon).digest("hex"),
  };
};

test("packages a distinct valid icon for every supported environment", () => {
  const identities = ["local", "dev", "staging", "production"].map(
    (environment) => {
      const config = loadBuilderConfig(environment);
      expect(config.nsis.installerIcon).toBe(config.win.icon);
      expect(config.nsis.uninstallerIcon).toBe(config.win.icon);
      const icon = inspectIco(config.win.icon);
      expect(icon.dimensions).toEqual([256, 256]);
      return { path: config.win.icon, digest: icon.digest };
    },
  );

  expect(new Set(identities.map((identity) => identity.path)).size).toBe(
    identities.length,
  );
  expect(new Set(identities.map((identity) => identity.digest)).size).toBe(
    identities.length,
  );
});

test("unknown environments use the production identity", () => {
  expect(loadBuilderConfig("preview").win.icon).toBe(
    "build-resources/icons/production/icon.ico",
  );
});
