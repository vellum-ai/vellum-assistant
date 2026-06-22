import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import JSZip from "jszip";

import {
  listBundles,
  readBundleMetadata,
  removeBundle,
  stripUnsafeEntries,
  unpackBundle,
  type BundleScanData,
} from "./bundle-manager";
import { resolveRelativePath } from "./app-protocol";

let tmpDir: string;

const makeScanData = (overrides?: Partial<BundleScanData>): BundleScanData => ({
  manifest: {
    format_version: 1,
    name: "Test App",
    description: "A test bundle",
    icon: "🧪",
    entry: "index.html",
    capabilities: ["display"],
    created_by: "user@example.com",
    created_at: "2025-01-01T00:00:00Z",
  },
  scanResult: { passed: true, blocked: [], warnings: [] },
  signatureResult: { trustTier: "unsigned" },
  bundleSizeBytes: 1024,
  ...overrides,
});

async function createTestZip(
  files: Record<string, string | Buffer>,
): Promise<string> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content);
  }
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  const zipPath = path.join(tmpDir, "test.vellum");
  await fs.writeFile(zipPath, buf);
  return zipPath;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mgr-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("unpackBundle", () => {
  test("extracts files and writes metadata", async () => {
    const zipPath = await createTestZip({
      "index.html": "<h1>hello</h1>",
      "assets/style.css": "body{}",
    });
    const bundlesRoot = path.join(tmpDir, "bundles");
    await fs.mkdir(bundlesRoot, { recursive: true });

    const meta = await unpackBundle(bundlesRoot, zipPath, makeScanData());

    expect(meta.uuid).toBeTruthy();
    expect(meta.name).toBe("Test App");
    expect(meta.entry).toBe("index.html");
    expect(meta.trustTier).toBe("unsigned");
    expect(meta.capabilities).toEqual(["display"]);
    expect(meta.bundleSizeBytes).toBe(1024);

    const html = await fs.readFile(
      path.join(bundlesRoot, meta.uuid, "index.html"),
      "utf-8",
    );
    expect(html).toBe("<h1>hello</h1>");

    const css = await fs.readFile(
      path.join(bundlesRoot, meta.uuid, "assets/style.css"),
      "utf-8",
    );
    expect(css).toBe("body{}");

    const metaFile = await fs.readFile(
      path.join(bundlesRoot, meta.uuid + "-meta.json"),
      "utf-8",
    );
    const parsed = JSON.parse(metaFile);
    expect(parsed.uuid).toBe(meta.uuid);
    expect(parsed.installedAt).toBeTruthy();
  });

  test("rejects path traversal entries", () => {
    // JSZip normalizes ../  in entry names, so we test the guard directly
    // via resolveRelativePath (the shared path-traversal predicate that
    // bundle-manager delegates to internally).
    const bundleDir = "/bundles/uuid";
    expect(resolveRelativePath(bundleDir, "sub/../../escape.txt")).toEqual({
      kind: "forbidden",
    });
    expect(resolveRelativePath(bundleDir, "../../../etc/passwd")).toEqual({
      kind: "forbidden",
    });
    // Safe paths resolve without error
    expect(resolveRelativePath(bundleDir, "index.html")).toEqual({
      kind: "ok",
      resolved: "/bundles/uuid/index.html",
    });
    expect(resolveRelativePath(bundleDir, "assets/style.css")).toEqual({
      kind: "ok",
      resolved: "/bundles/uuid/assets/style.css",
    });
  });
});

describe("stripUnsafeEntries", () => {
  test("removes symlinks", async () => {
    const dir = path.join(tmpDir, "strip-test");
    await fs.mkdir(dir, { recursive: true });

    const realFile = path.join(dir, "real.txt");
    await fs.writeFile(realFile, "content");

    const linkPath = path.join(dir, "link.txt");
    await fs.symlink(realFile, linkPath);

    await stripUnsafeEntries(dir);

    const remaining = await fs.readdir(dir);
    expect(remaining).toContain("real.txt");
    expect(remaining).not.toContain("link.txt");
  });

  test("walks nested directories", async () => {
    const dir = path.join(tmpDir, "nested-test");
    const sub = path.join(dir, "sub");
    await fs.mkdir(sub, { recursive: true });

    const realFile = path.join(sub, "real.txt");
    await fs.writeFile(realFile, "content");

    const linkPath = path.join(sub, "link.txt");
    await fs.symlink(realFile, linkPath);

    await stripUnsafeEntries(dir);

    const remaining = await fs.readdir(sub);
    expect(remaining).toContain("real.txt");
    expect(remaining).not.toContain("link.txt");
  });
});

describe("readBundleMetadata", () => {
  test("reads existing metadata", async () => {
    const zipPath = await createTestZip({ "index.html": "<h1>hi</h1>" });
    const bundlesRoot = path.join(tmpDir, "bundles");
    await fs.mkdir(bundlesRoot, { recursive: true });

    const meta = await unpackBundle(bundlesRoot, zipPath, makeScanData());
    const read = await readBundleMetadata(bundlesRoot, meta.uuid);

    expect(read).not.toBeNull();
    expect(read!.uuid).toBe(meta.uuid);
    expect(read!.name).toBe("Test App");
  });

  test("returns null for missing metadata", async () => {
    const bundlesRoot = path.join(tmpDir, "bundles");
    await fs.mkdir(bundlesRoot, { recursive: true });

    const result = await readBundleMetadata(
      bundlesRoot,
      "nonexistent-uuid-1234",
    );
    expect(result).toBeNull();
  });
});

describe("listBundles", () => {
  test("lists all installed bundles", async () => {
    const bundlesRoot = path.join(tmpDir, "bundles");
    await fs.mkdir(bundlesRoot, { recursive: true });

    const zip1 = await createTestZip({ "index.html": "<h1>one</h1>" });
    const zip2 = await createTestZip({ "index.html": "<h1>two</h1>" });

    await unpackBundle(
      bundlesRoot,
      zip1,
      makeScanData({ manifest: { ...makeScanData().manifest, name: "App 1" } }),
    );
    await unpackBundle(
      bundlesRoot,
      zip2,
      makeScanData({ manifest: { ...makeScanData().manifest, name: "App 2" } }),
    );

    const bundles = await listBundles(bundlesRoot);
    expect(bundles).toHaveLength(2);

    const names = bundles.map((b) => b.name).sort();
    expect(names).toEqual(["App 1", "App 2"]);
  });

  test("returns empty array for nonexistent directory", async () => {
    const bundles = await listBundles(path.join(tmpDir, "nope"));
    expect(bundles).toEqual([]);
  });
});

describe("removeBundle", () => {
  test("removes bundle directory and metadata", async () => {
    const bundlesRoot = path.join(tmpDir, "bundles");
    await fs.mkdir(bundlesRoot, { recursive: true });

    const zipPath = await createTestZip({ "index.html": "<h1>bye</h1>" });
    const meta = await unpackBundle(bundlesRoot, zipPath, makeScanData());

    await removeBundle(bundlesRoot, meta.uuid);

    const dirExists = await fs
      .stat(path.join(bundlesRoot, meta.uuid))
      .then(() => true)
      .catch(() => false);
    expect(dirExists).toBe(false);

    const metaExists = await fs
      .stat(path.join(bundlesRoot, meta.uuid + "-meta.json"))
      .then(() => true)
      .catch(() => false);
    expect(metaExists).toBe(false);
  });

  test("does not throw for already-removed bundle", async () => {
    const bundlesRoot = path.join(tmpDir, "bundles");
    await fs.mkdir(bundlesRoot, { recursive: true });

    await expect(
      removeBundle(bundlesRoot, "already-gone-uuid"),
    ).resolves.toBeUndefined();
  });
});
