/**
 * Unit tests for the workspace-volume discovery helper.
 *
 * Mountinfo fixtures are written to a tempdir so we can exercise the real
 * readFile path without touching `/proc`. The env-var fallback is tested by
 * passing an explicit `env` override so tests don't mutate `process.env`.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  getWorkspaceVolumeName,
  parseWorkspaceVolumeFromMountinfo,
  resetWorkspaceVolumeNameCacheForTests,
} from "../workspace-volume.js";

let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "workspace-volume-test-"));
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/**
 * Representative mountinfo line for a Docker named volume mounted at
 * `/workspace`. Taken (anonymized) from a real Docker container running
 * under the overlay2 storage driver.
 */
const WORKSPACE_VOLUME_LINE =
  "2345 2100 0:123 / /workspace rw,relatime shared:456 - ext4 /var/lib/docker/volumes/myassistant-workspace/_data rw,seclabel";

/** A mountinfo line for an unrelated mount — used to verify we skip it. */
const ROOT_MOUNT_LINE =
  "100 99 8:1 / / rw,relatime - ext4 /dev/sda1 rw,seclabel";

/** A mountinfo line for `/proc` — also unrelated, here as noise. */
const PROC_MOUNT_LINE =
  "200 100 0:4 / /proc rw,relatime - proc proc rw";

function writeFixture(name: string, contents: string): string {
  const path = join(tempDir, name);
  writeFileSync(path, contents, "utf8");
  return path;
}

describe("parseWorkspaceVolumeFromMountinfo", () => {
  test("extracts the volume name when /workspace is backed by a Docker volume", () => {
    const raw = [ROOT_MOUNT_LINE, WORKSPACE_VOLUME_LINE, PROC_MOUNT_LINE].join(
      "\n",
    );
    expect(parseWorkspaceVolumeFromMountinfo(raw)).toBe(
      "myassistant-workspace",
    );
  });

  test("returns null when there is no /workspace entry", () => {
    const raw = [ROOT_MOUNT_LINE, PROC_MOUNT_LINE].join("\n");
    expect(parseWorkspaceVolumeFromMountinfo(raw)).toBeNull();
  });

  test("returns null when /workspace is a host bind mount (not a Docker volume)", () => {
    // Host bind mounts show up with a non-Docker source path.
    const bindMountLine =
      "2345 2100 0:123 / /workspace rw,relatime shared:456 - ext4 /home/user/workspace rw,seclabel";
    expect(parseWorkspaceVolumeFromMountinfo(bindMountLine)).toBeNull();
  });

  test("handles volume names with dashes, underscores, and dots", () => {
    const line =
      "2345 2100 0:123 / /workspace rw,relatime shared:456 - ext4 /var/lib/docker/volumes/my_assistant-v1.2/_data rw,seclabel";
    expect(parseWorkspaceVolumeFromMountinfo(line)).toBe(
      "my_assistant-v1.2",
    );
  });

  test("handles mountinfo lines with multiple optional fields before the separator", () => {
    // Some configurations include several optional fields (`shared:N`,
    // `master:N`, `propagate_from:N`). The parser must still find the
    // `-` separator and not confuse optional fields with the mount_point.
    const line =
      "2345 2100 0:123 / /workspace rw,relatime shared:456 master:789 - ext4 /var/lib/docker/volumes/multi-opt/_data rw,seclabel";
    expect(parseWorkspaceVolumeFromMountinfo(line)).toBe("multi-opt");
  });

  test("returns null for an empty blob", () => {
    expect(parseWorkspaceVolumeFromMountinfo("")).toBeNull();
  });
});

describe("getWorkspaceVolumeName", () => {
  test("returns the Docker volume name when mountinfo has a /workspace entry", async () => {
    const path = writeFixture(
      "mountinfo-happy",
      [ROOT_MOUNT_LINE, WORKSPACE_VOLUME_LINE, PROC_MOUNT_LINE].join("\n"),
    );
    const result = await getWorkspaceVolumeName({
      mountinfoPath: path,
      env: {},
    });
    expect(result).toBe("myassistant-workspace");
  });

  test("returns null when mountinfo has no /workspace entry and no env fallback", async () => {
    const path = writeFixture(
      "mountinfo-no-workspace",
      [ROOT_MOUNT_LINE, PROC_MOUNT_LINE].join("\n"),
    );
    const result = await getWorkspaceVolumeName({
      mountinfoPath: path,
      env: {},
    });
    expect(result).toBeNull();
  });

  test("falls back to VELLUM_WORKSPACE_VOLUME_NAME when mountinfo yields nothing", async () => {
    const path = writeFixture(
      "mountinfo-no-workspace-env-hint",
      [ROOT_MOUNT_LINE].join("\n"),
    );
    const result = await getWorkspaceVolumeName({
      mountinfoPath: path,
      env: { VELLUM_WORKSPACE_VOLUME_NAME: "env-provided-volume" },
    });
    expect(result).toBe("env-provided-volume");
  });

  test("prefers the mountinfo value over the env-var fallback when both are present", async () => {
    const path = writeFixture(
      "mountinfo-both",
      [WORKSPACE_VOLUME_LINE].join("\n"),
    );
    const result = await getWorkspaceVolumeName({
      mountinfoPath: path,
      env: { VELLUM_WORKSPACE_VOLUME_NAME: "env-provided-volume" },
    });
    expect(result).toBe("myassistant-workspace");
  });

  test("ignores an empty-string env-var value", async () => {
    const path = writeFixture(
      "mountinfo-empty-env",
      [ROOT_MOUNT_LINE].join("\n"),
    );
    const result = await getWorkspaceVolumeName({
      mountinfoPath: path,
      env: { VELLUM_WORKSPACE_VOLUME_NAME: "" },
    });
    expect(result).toBeNull();
  });

  test("returns null cleanly when mountinfo cannot be read (macOS case)", async () => {
    // Simulate `/proc/self/mountinfo` not existing by pointing at a file
    // under tempDir that we never created.
    const missingPath = join(tempDir, "does-not-exist-mountinfo");
    const result = await getWorkspaceVolumeName({
      mountinfoPath: missingPath,
      env: {},
    });
    expect(result).toBeNull();
  });

  test("uses the env-var fallback even when mountinfo cannot be read", async () => {
    const missingPath = join(tempDir, "also-missing-mountinfo");
    const result = await getWorkspaceVolumeName({
      mountinfoPath: missingPath,
      env: { VELLUM_WORKSPACE_VOLUME_NAME: "hinted-volume" },
    });
    expect(result).toBe("hinted-volume");
  });

  test("caches the result across calls when no overrides are supplied", async () => {
    resetWorkspaceVolumeNameCacheForTests();
    // First default-options call resolves (and caches) a lookup. On
    // macOS/dev machines this is almost always null; that's fine — the
    // contract we're verifying is that the same promise reference is
    // returned on subsequent calls, not the specific value.
    const first = getWorkspaceVolumeName();
    const second = getWorkspaceVolumeName();
    expect(second).toBe(first);
    await first;
    resetWorkspaceVolumeNameCacheForTests();
  });

  test("override calls bypass the module-level cache", async () => {
    resetWorkspaceVolumeNameCacheForTests();
    const pathA = writeFixture(
      "mountinfo-cache-a",
      [WORKSPACE_VOLUME_LINE].join("\n"),
    );
    const pathB = writeFixture(
      "mountinfo-cache-b",
      [
        "2345 2100 0:123 / /workspace rw,relatime shared:456 - ext4 /var/lib/docker/volumes/volume-b/_data rw,seclabel",
      ].join("\n"),
    );
    const resultA = await getWorkspaceVolumeName({
      mountinfoPath: pathA,
      env: {},
    });
    const resultB = await getWorkspaceVolumeName({
      mountinfoPath: pathB,
      env: {},
    });
    expect(resultA).toBe("myassistant-workspace");
    expect(resultB).toBe("volume-b");
    resetWorkspaceVolumeNameCacheForTests();
  });
});
