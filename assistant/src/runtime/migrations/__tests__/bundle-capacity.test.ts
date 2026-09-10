import * as fs from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createGzip } from "node:zlib";
import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { pack } from "tar-stream";

import { buildVBundle, streamExportVBundle } from "../vbundle-builder.js";
import { DefaultPathResolver } from "../vbundle-import-analyzer.js";
import { streamCommitImport } from "../vbundle-streaming-importer.js";
import { preflightBundleStream } from "../vbundle-streaming-preflight.js";
import { buildTestManifest, defaultV1Options } from "./v1-test-helpers.js";

const workspaceDir = process.env.VELLUM_WORKSPACE_DIR!;
const originalStatfs = fs.statfsSync(workspaceDir);
let diskSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
  diskSpy?.mockRestore();
});

function reportFreeBytes(bytes: number): void {
  diskSpy = spyOn(fs, "statfsSync").mockReturnValue({
    ...originalStatfs,
    bavail: bytes,
    bsize: 1,
  });
}

function declaredOnlyBundle(size: number): Readable {
  const manifest = buildTestManifest({
    contents: [
      {
        path: "workspace/data/db/assistant.db",
        size_bytes: size,
        sha256: "a".repeat(64),
      },
    ],
  });
  const tar = pack() as ReturnType<typeof pack> & {
    entry(header: { name: string }, data: string): void;
    finalize(): void;
  };
  tar.entry({ name: "manifest.json" }, JSON.stringify(manifest));
  tar.finalize();
  return tar.pipe(createGzip());
}

describe("Teleport capacity", () => {
  test("an import above 16 GiB reaches content validation when space permits", async () => {
    reportFreeBytes(100 * 1024 ** 3);
    const result = await streamCommitImport({
      source: declaredOnlyBundle(32 * 1024 ** 3),
      workspaceDir,
      pathResolver: new DefaultPathResolver(
        workspaceDir,
        join(workspaceDir, "hooks"),
      ),
      maxBundleBytes: 58 * 1024 ** 3,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "validation_failed") {
      expect(
        result.errors.some((error) => error.code === "missing_entry"),
      ).toBe(true);
      expect(
        result.errors.some((error) => error.code === "bundle_too_large"),
      ).toBe(false);
    } else {
      throw new Error("Expected missing-entry validation");
    }
  });

  test("an extracted bundle over the plan limit is rejected before staging", async () => {
    reportFreeBytes(100 * 1024 ** 3);
    const before = fs.readdirSync(workspaceDir);
    const result = await streamCommitImport({
      source: declaredOnlyBundle(32 * 1024 ** 3),
      workspaceDir,
      pathResolver: new DefaultPathResolver(
        workspaceDir,
        join(workspaceDir, "hooks"),
      ),
      maxBundleBytes: 28 * 1024 ** 3,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "validation_failed") {
      expect(result.errors[0]?.code).toBe("bundle_too_large");
    } else {
      throw new Error("Expected size validation");
    }
    expect(fs.readdirSync(workspaceDir)).toEqual(before);
  });

  test("preflight checks extracted bytes against remaining space without writing", async () => {
    reportFreeBytes(2 * 1024 ** 3 + 100);
    const bundle = buildVBundle({
      ...defaultV1Options(),
      files: [
        { path: "workspace/data/db/assistant.db", data: new Uint8Array(1024) },
      ],
    });
    const before = fs.readdirSync(workspaceDir);
    const result = await preflightBundleStream(
      Readable.from([bundle.archive]),
      new DefaultPathResolver(workspaceDir, join(workspaceDir, "hooks")),
      workspaceDir,
    );
    expect(result.can_import).toBe(false);
    expect("validation" in result && result.validation.errors[0]?.code).toBe(
      "bundle_too_large",
    );
    expect(fs.readdirSync(workspaceDir)).toEqual(before);
  });

  test("export rejects oversized data before hashing or writing an archive", async () => {
    await expect(
      streamExportVBundle({
        ...defaultV1Options(),
        workspaceDir,
        credentials: [{ account: "test-key", value: "large value" }],
        maxBundleBytes: 1,
      }),
    ).rejects.toThrow("destination allows 1 bytes");
  });

  test("preflight hashes existing destination files without reading them into a buffer", async () => {
    reportFreeBytes(100 * 1024 ** 3);
    const data = new Uint8Array(128 * 1024).fill(1);
    fs.writeFileSync(join(workspaceDir, "capacity-existing.bin"), data);
    const bundle = buildVBundle({
      ...defaultV1Options(),
      files: [
        { path: "workspace/data/db/assistant.db", data: new Uint8Array() },
        { path: "workspace/capacity-existing.bin", data },
      ],
    });
    const bufferedRead = spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("Preflight must stream existing files");
    });
    try {
      const result = await preflightBundleStream(
        Readable.from([bundle.archive]),
        new DefaultPathResolver(workspaceDir, join(workspaceDir, "hooks")),
        workspaceDir,
      );
      expect(result.can_import).toBe(true);
      expect(
        "files" in result &&
          result.files.find((file) =>
            file.path.endsWith("capacity-existing.bin"),
          )?.action,
      ).toBe("unchanged");
      expect(bufferedRead).not.toHaveBeenCalled();
    } finally {
      bufferedRead.mockRestore();
    }
  });

  test("preflight blocks incompatible transfer receipts before import", async () => {
    reportFreeBytes(100 * 1024 ** 3);
    const bundle = buildVBundle({
      ...defaultV1Options(),
      compatibility: {
        min_runtime_version: "999.0.0",
        max_runtime_version: null,
      },
      files: [
        { path: "workspace/data/db/assistant.db", data: new Uint8Array() },
      ],
    });
    const result = await preflightBundleStream(
      Readable.from([bundle.archive]),
      new DefaultPathResolver(workspaceDir, join(workspaceDir, "hooks")),
      workspaceDir,
    );
    expect(result.can_import).toBe(false);
    expect("validation" in result && result.validation.errors[0]?.code).toBe(
      "version_incompatible",
    );
  });
});
