import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { syncLocalPluginIcons } from "../sync-local-plugin-icons.mjs";

function makePng(width, height) {
  const magic = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  const ihdrLength = Buffer.alloc(4);
  ihdrLength.writeUInt32BE(13);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  return Buffer.concat([magic, ihdrLength, Buffer.from("IHDR"), ihdr]);
}

let repoRoot;
let marketplacePath;
let webAssetsDir;

function writeLocalPlugin({
  name = "example",
  icon = makePng(32, 32),
  sourceVersion = "1.0.1",
  packageVersion = "1.0.1",
  logo = `${name}-mcp.png`,
} = {}) {
  const packageRoot = join(repoRoot, "plugins/mcp-catalog", name);
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "plugin.json"),
    JSON.stringify({ name, version: packageVersion }),
  );
  writeFileSync(join(packageRoot, "icon.png"), icon);
  mkdirSync(join(repoRoot, "plugins"), { recursive: true });
  writeFileSync(
    marketplacePath,
    JSON.stringify({
      plugins: [
        {
          name,
          source: {
            source: "local",
            path: `plugins/mcp-catalog/${name}`,
            version: sourceVersion,
          },
          integration: { kind: "mcp", logo },
        },
      ],
    }),
  );
  return icon;
}

const run = (check = false) =>
  syncLocalPluginIcons({
    repoRoot,
    marketplacePath,
    webAssetsDir,
    check,
    log: { log() {} },
  });

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "local-plugin-icons-"));
  marketplacePath = join(repoRoot, "plugins/marketplace.json");
  webAssetsDir = join(repoRoot, "clients/web/public/images/integrations");
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

describe("syncLocalPluginIcons", () => {
  test("derives a byte-identical web copy and passes check mode", () => {
    const icon = writeLocalPlugin();

    const synced = run();

    expect(synced.ok).toBe(true);
    expect(synced.synced).toEqual(["example-mcp.png"]);
    expect(readFileSync(join(webAssetsDir, "example-mcp.png")).equals(icon)).toBe(
      true,
    );
    expect(run(true)).toEqual({ ok: true, errors: [], synced: [], removed: [] });
  });

  test("reports drift and stale derived copies in check mode", () => {
    writeLocalPlugin();
    run();
    writeFileSync(join(webAssetsDir, "example-mcp.png"), makePng(16, 16));
    writeFileSync(join(webAssetsDir, "stale-mcp.png"), makePng(16, 16));

    const result = run(true);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "derived web logo example-mcp.png differs from example/icon.png",
    );
    expect(result.errors).toContain("stale derived local MCP logo stale-mcp.png");
  });

  test("validates package ownership and icon bytes before writing", () => {
    writeLocalPlugin({
      icon: Buffer.from("not a png"),
      sourceVersion: "1.0.0",
      logo: "shared.svg",
    });
    mkdirSync(webAssetsDir, { recursive: true });
    const existing = Buffer.from("keep me");
    writeFileSync(join(webAssetsDir, "existing-mcp.png"), existing);

    const result = run();

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("integration.logo");
    expect(result.errors.join(" ")).toContain("source.version");
    expect(result.errors.join(" ")).toContain("contract-valid PNG");
    expect(
      readFileSync(join(webAssetsDir, "existing-mcp.png")).equals(existing),
    ).toBe(true);
  });

  test("removes stale derived copies while syncing", () => {
    writeLocalPlugin();
    mkdirSync(webAssetsDir, { recursive: true });
    writeFileSync(join(webAssetsDir, "stale-mcp.png"), makePng(16, 16));

    const result = run();

    expect(result.removed).toEqual(["stale-mcp.png"]);
    expect(() => readFileSync(join(webAssetsDir, "stale-mcp.png"))).toThrow();
  });
});
