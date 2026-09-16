import { describe, expect, test } from "bun:test";

import {
  collectMountSnapshot,
  diffMountSnapshots,
  isWatchedMount,
  mountDiffIsEmpty,
  type MountInfoEntry,
  type MountSnapshot,
  parseMountinfo,
  type PathFsSnapshot,
  unescapeMountField,
} from "../mount-watch.js";

const SAMPLE_MOUNTINFO = `22 1 0:21 / / rw,relatime - overlay overlay rw,lowerdir=/a,upperdir=/b,workdir=/c
36 22 0:26 / /workspace rw,relatime - virtiofs kataShared rw
48 22 0:27 / /data rw,relatime - virtiofs kataShared rw
25 22 0:23 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw
`;

function entry(
  fields: Partial<MountInfoEntry> & Pick<MountInfoEntry, "mountPoint" | "fsType">,
): MountInfoEntry {
  return {
    mountId: fields.mountId ?? "1",
    parentId: fields.parentId ?? "0",
    majorMinor: fields.majorMinor ?? "0:1",
    root: fields.root ?? "/",
    mountPoint: fields.mountPoint,
    mountOptions: fields.mountOptions ?? "rw,relatime",
    fsType: fields.fsType,
    source: fields.source ?? "kataShared",
    superOptions: fields.superOptions ?? "rw",
  };
}

function pathFs(
  fields: Partial<PathFsSnapshot> & Pick<PathFsSnapshot, "path">,
): PathFsSnapshot {
  return {
    path: fields.path,
    type: fields.type ?? 0x65735546,
    blockSize: fields.blockSize ?? 4096,
    blocks: fields.blocks ?? 12_884_901,
    files: fields.files ?? 1_000_000,
    ...(fields.error != null ? { error: fields.error } : {}),
  };
}

function snapshot(partial: Partial<MountSnapshot>): MountSnapshot {
  return {
    mounts: partial.mounts ?? [],
    paths: partial.paths ?? [],
  };
}

describe("unescapeMountField", () => {
  test("decodes octal-escaped spaces", () => {
    expect(unescapeMountField("/workspace/my\\040dir")).toBe("/workspace/my dir");
  });
});

describe("parseMountinfo", () => {
  test("reads mount point, fstype, and source", () => {
    const parsed = parseMountinfo(SAMPLE_MOUNTINFO);
    expect(parsed).toEqual([
      entry({
        mountId: "22",
        parentId: "1",
        majorMinor: "0:21",
        mountPoint: "/",
        fsType: "overlay",
        source: "overlay",
        superOptions: "rw,lowerdir=/a,upperdir=/b,workdir=/c",
      }),
      entry({
        mountId: "36",
        parentId: "22",
        majorMinor: "0:26",
        mountPoint: "/workspace",
        fsType: "virtiofs",
      }),
      entry({
        mountId: "48",
        parentId: "22",
        majorMinor: "0:27",
        mountPoint: "/data",
        fsType: "virtiofs",
      }),
      entry({
        mountId: "25",
        parentId: "22",
        majorMinor: "0:23",
        mountPoint: "/proc",
        mountOptions: "rw,nosuid,nodev,noexec,relatime",
        fsType: "proc",
        source: "proc",
      }),
    ]);
  });

  test("skips malformed lines", () => {
    expect(parseMountinfo("not-a-mount-line\n")).toEqual([]);
  });
});

describe("isWatchedMount", () => {
  test("keeps virtiofs regardless of mount point", () => {
    expect(
      isWatchedMount(entry({ mountPoint: "/secret-bind", fsType: "virtiofs" })),
    ).toBe(true);
  });

  test("keeps /workspace and /data even when they are overlay", () => {
    expect(
      isWatchedMount(entry({ mountPoint: "/workspace", fsType: "overlay" })),
    ).toBe(true);
    expect(isWatchedMount(entry({ mountPoint: "/data", fsType: "overlay" }))).toBe(
      true,
    );
  });

  test("drops proc and the root overlay", () => {
    expect(isWatchedMount(entry({ mountPoint: "/proc", fsType: "proc" }))).toBe(
      false,
    );
    expect(isWatchedMount(entry({ mountPoint: "/", fsType: "overlay" }))).toBe(
      false,
    );
  });
});

describe("diffMountSnapshots", () => {
  test("stays empty when the table is unchanged", () => {
    const current = snapshot({
      mounts: [entry({ mountPoint: "/workspace", fsType: "virtiofs" })],
      paths: [pathFs({ path: "/workspace" })],
    });
    expect(mountDiffIsEmpty(diffMountSnapshots(current, current))).toBe(true);
  });

  test("reports a dropped virtiofs bind as removed", () => {
    const previous = snapshot({
      mounts: [
        entry({ mountPoint: "/workspace", fsType: "virtiofs" }),
        entry({ mountPoint: "/data", fsType: "virtiofs" }),
      ],
    });
    const current = snapshot({
      mounts: [entry({ mountPoint: "/data", fsType: "virtiofs" })],
    });
    const diff = diffMountSnapshots(previous, current);
    expect(diff.removed.map((row) => row.mountPoint)).toEqual(["/workspace"]);
    expect(diff.added).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  test("reports a fstype swap at the same mount point as changed", () => {
    const previous = snapshot({
      mounts: [entry({ mountPoint: "/workspace", fsType: "virtiofs" })],
    });
    const current = snapshot({
      mounts: [entry({ mountPoint: "/workspace", fsType: "overlay", source: "overlay" })],
    });
    const diff = diffMountSnapshots(previous, current);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].previous.fsType).toBe("virtiofs");
    expect(diff.changed[0].current.fsType).toBe("overlay");
  });

  test("reports a statfs size collapse on a watched path", () => {
    const previous = snapshot({
      paths: [pathFs({ path: "/workspace", blocks: 12_884_901 })],
    });
    const current = snapshot({
      paths: [pathFs({ path: "/workspace", blocks: 25_165_824, type: 0x794c7630 })],
    });
    const diff = diffMountSnapshots(previous, current);
    expect(diff.pathChanges).toHaveLength(1);
    expect(diff.pathChanges[0].previous.blocks).toBe(12_884_901);
    expect(diff.pathChanges[0].current.blocks).toBe(25_165_824);
  });
});

describe("collectMountSnapshot", () => {
  test("returns null on Windows and macOS", () => {
    expect(collectMountSnapshot({ platform: "win32" })).toBeNull();
    expect(collectMountSnapshot({ platform: "darwin" })).toBeNull();
  });

  test("filters to assistant-container volume mounts", () => {
    const snapshot = collectMountSnapshot({
      platform: "linux",
      readMountinfo: () => SAMPLE_MOUNTINFO,
      statPath: (path) => pathFs({ path }),
      watchedMountPoints: ["/workspace", "/data"],
    });
    expect(snapshot).not.toBeNull();
    expect(snapshot?.mounts.map((row) => row.mountPoint)).toEqual([
      "/data",
      "/workspace",
    ]);
    expect(snapshot?.paths.map((row) => row.path)).toEqual([
      "/workspace",
      "/data",
    ]);
  });

  test("stats watched paths even when they are missing from the host", () => {
    const snapshot = collectMountSnapshot({
      platform: "linux",
      readMountinfo: () => SAMPLE_MOUNTINFO,
      statPath: (path) =>
        pathFs({ path, type: null, blockSize: null, blocks: null, files: null, error: "statfs-failed" }),
      watchedMountPoints: ["/workspace", "/data"],
    });
    expect(snapshot?.paths).toEqual([
      pathFs({
        path: "/workspace",
        type: null,
        blockSize: null,
        blocks: null,
        files: null,
        error: "statfs-failed",
      }),
      pathFs({
        path: "/data",
        type: null,
        blockSize: null,
        blocks: null,
        files: null,
        error: "statfs-failed",
      }),
    ]);
  });
});
