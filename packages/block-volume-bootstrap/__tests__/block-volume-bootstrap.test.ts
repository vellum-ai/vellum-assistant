import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const initScript = resolve(
  packageRoot,
  "scripts/vellum-block-volume-init.sh",
);
const mountScript = resolve(
  packageRoot,
  "scripts/vellum-block-volume-mount.sh",
);
const resizeScript = resolve(
  packageRoot,
  "scripts/vellum-block-volume-resize.sh",
);

function runScript(
  script: string,
  {
    args = [],
    env = {},
  }: { args?: string[]; env?: Record<string, string> } = {},
) {
  const result = Bun.spawnSync({
    cmd: ["sh", script, ...args],
    cwd: packageRoot,
    env: {
      PATH: process.env.PATH ?? "",
      VELLUM_FILESYSTEM_MODE: "block",
      VELLUM_BLOCK_DRY_RUN: "1",
      VELLUM_BLOCK_DEVICE: "/dev/test-block",
      VELLUM_BLOCK_ROOT: "/mnt/test-root",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

describe("block volume bootstrap scripts", () => {
  test("mount helper parses bind specs and logs mount commands in order", () => {
    const result = runScript(mountScript, {
      args: ["--", "bun", "run", "src/index.ts"],
      env: {
        VELLUM_BLOCK_BIND_SPECS:
          "assistant-data:/data:rw;workspace:/workspace:ro",
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(
      [
        "DRY-RUN: wait for block device /dev/test-block",
        "DRY-RUN: mkdir -p /mnt/test-root",
        "DRY-RUN: findmnt --mountpoint /mnt/test-root",
        "DRY-RUN: mount /dev/test-block /mnt/test-root",
        "DRY-RUN: mkdir -p /mnt/test-root/assistant-data",
        "DRY-RUN: mkdir -p /data",
        "DRY-RUN: findmnt --mountpoint /data",
        "DRY-RUN: mount --bind /mnt/test-root/assistant-data /data",
        "DRY-RUN: mkdir -p /mnt/test-root/workspace",
        "DRY-RUN: mkdir -p /workspace",
        "DRY-RUN: findmnt --mountpoint /workspace",
        "DRY-RUN: mount --bind /mnt/test-root/workspace /workspace",
        "DRY-RUN: mount -o remount,bind,ro /workspace",
        "DRY-RUN: exec bun run src/index.ts",
      ].join("\n"),
    );
  });

  test("mount helper normalizes trailing slashes on bind targets", () => {
    const result = runScript(mountScript, {
      args: ["--", "true"],
      env: {
        VELLUM_BLOCK_BIND_SPECS: "workspace:/workspace///:ro",
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("DRY-RUN: mkdir -p /workspace");
    expect(result.stderr).toContain(
      "DRY-RUN: mount --bind /mnt/test-root/workspace /workspace",
    );
    expect(result.stderr).toContain("DRY-RUN: mount -o remount,bind,ro /workspace");
    expect(result.stderr).not.toContain("/workspace///");
  });

  test("mount helper logs setpriv execution when uid and gid are set", () => {
    const result = runScript(mountScript, {
      args: ["--", "bun", "run", "src/managed-main.ts"],
      env: {
        VELLUM_BLOCK_BIND_SPECS: "ces-data:/ces-data:rw",
        VELLUM_BLOCK_EXEC_UID: "1001",
        VELLUM_BLOCK_EXEC_GID: "1001",
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(
      "DRY-RUN: exec setpriv --reuid 1001 --regid 1001 --clear-groups -- bun run src/managed-main.ts",
    );
  });

  test("mount helper rejects uid-only privilege drops", () => {
    const result = runScript(mountScript, {
      args: ["--", "true"],
      env: {
        VELLUM_BLOCK_BIND_SPECS: "ces-data:/ces-data:rw",
        VELLUM_BLOCK_EXEC_UID: "1001",
      },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(
      "VELLUM_BLOCK_EXEC_UID and VELLUM_BLOCK_EXEC_GID must be set together",
    );
    expect(result.stderr).not.toContain("wait for block device");
  });

  test("mount helper rejects gid-only privilege drops", () => {
    const result = runScript(mountScript, {
      args: ["--", "true"],
      env: {
        VELLUM_BLOCK_BIND_SPECS: "ces-data:/ces-data:rw",
        VELLUM_BLOCK_EXEC_GID: "1001",
      },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(
      "VELLUM_BLOCK_EXEC_UID and VELLUM_BLOCK_EXEC_GID must be set together",
    );
    expect(result.stderr).not.toContain("wait for block device");
  });

  test("mount helper rejects invalid bind specs", () => {
    const result = runScript(mountScript, {
      args: ["--", "true"],
      env: {
        VELLUM_BLOCK_BIND_SPECS: "workspace:/workspace:readonly",
      },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("invalid bind mode 'readonly'");
  });

  test("mount helper rejects slash-only bind targets", () => {
    const result = runScript(mountScript, {
      args: ["--", "true"],
      env: {
        VELLUM_BLOCK_BIND_SPECS: "workspace:////:ro",
      },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("bind target must not be empty or /");
    expect(result.stderr).not.toContain("mount --bind");
    expect(result.stderr).not.toContain("remount,bind,ro");
  });

  test("init helper formats only devices with no filesystem", () => {
    const result = runScript(initScript);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("DRY-RUN: blkid -o value -s TYPE /dev/test-block");
    expect(result.stderr).toContain("DRY-RUN: mkfs.ext4 -F /dev/test-block");
    expect(result.stderr).toContain("DRY-RUN: mount /dev/test-block /mnt/test-root");
    expect(result.stderr).toContain("DRY-RUN: mkdir -p /mnt/test-root/assistant-data");
    expect(result.stderr).toContain("DRY-RUN: chown 1001:1001 /mnt/test-root/workspace");
    expect(result.stderr).not.toContain("/mnt/test-root/gateway-security");
    expect(result.stderr).not.toContain("/mnt/test-root/ces-security");
    expect(result.stderr).toContain("DRY-RUN: chown 0:0 /mnt/test-root/dockerd-data");
  });

  test("init helper normalizes trailing slashes on block root", () => {
    const result = runScript(initScript, {
      env: {
        VELLUM_BLOCK_ROOT: "/mnt/test-root///",
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("DRY-RUN: mkdir -p /mnt/test-root");
    expect(result.stderr).toContain("DRY-RUN: mount /dev/test-block /mnt/test-root");
    expect(result.stderr).toContain("DRY-RUN: mkdir -p /mnt/test-root/workspace");
    expect(result.stderr).not.toContain("/mnt/test-root///");
  });

  test("init helper rejects slash-only block roots", () => {
    const result = runScript(initScript, {
      env: {
        VELLUM_BLOCK_ROOT: "////",
      },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("VELLUM_BLOCK_ROOT must not be empty or /");
    expect(result.stderr).not.toContain("wait for block device");
    expect(result.stderr).not.toContain("mkdir -p");
  });

  test("resize helper grows ext4 and prints requested bind path evidence", () => {
    const result = runScript(resizeScript, {
      args: ["/workspace"],
      env: {
        VELLUM_BLOCK_DRY_RUN_BLKID_TYPE: "ext4",
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(
      [
        "DRY-RUN: wait for block device /dev/test-block",
        "DRY-RUN: blkid -o value -s TYPE /dev/test-block",
        "DRY-RUN: resize2fs /dev/test-block",
        "DRY-RUN: findmnt --target /workspace",
        "DRY-RUN: df -h /workspace",
      ].join("\n"),
    );
  });

  test("resize helper normalizes trailing slashes on evidence paths", () => {
    const result = runScript(resizeScript, {
      args: ["/workspace///"],
      env: {
        VELLUM_BLOCK_DRY_RUN_BLKID_TYPE: "ext4",
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("DRY-RUN: findmnt --target /workspace");
    expect(result.stderr).toContain("DRY-RUN: df -h /workspace");
    expect(result.stderr).not.toContain("/workspace///");
  });

  test("resize helper rejects slash-only evidence paths", () => {
    const result = runScript(resizeScript, {
      args: ["////"],
      env: {
        VELLUM_BLOCK_DRY_RUN_BLKID_TYPE: "ext4",
      },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("bind target must not be empty or /");
    expect(result.stderr).not.toContain("findmnt --target");
    expect(result.stderr).not.toContain("df -h");
  });

  test("resize helper rejects non-ext4 filesystems", () => {
    const result = runScript(resizeScript, {
      env: {
        VELLUM_BLOCK_DRY_RUN_BLKID_TYPE: "xfs",
      },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(
      "/dev/test-block contains unsupported filesystem 'xfs'; expected ext4",
    );
    expect(result.stderr).not.toContain("resize2fs");
  });

  test("init helper resizes and never formats a device with an existing ext4 filesystem", () => {
    const result = runScript(initScript, {
      env: {
        VELLUM_BLOCK_DRY_RUN_BLKID_TYPE: "ext4",
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("mkfs.ext4");
    expect(result.stderr).toContain("already contains an ext4 filesystem");
    expect(result.stderr).toContain(
      [
        "vellum block volume: /dev/test-block already contains an ext4 filesystem",
        "DRY-RUN: wait for block device /dev/test-block",
        "DRY-RUN: blkid -o value -s TYPE /dev/test-block",
        "DRY-RUN: resize2fs /dev/test-block",
        "DRY-RUN: mkdir -p /mnt/test-root",
      ].join("\n"),
    );
  });

  test("init helper rejects non-ext4 existing filesystems before formatting", () => {
    const result = runScript(initScript, {
      env: {
        VELLUM_BLOCK_DRY_RUN_BLKID_TYPE: "xfs",
      },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(
      "/dev/test-block contains unsupported filesystem 'xfs'; expected ext4",
    );
    expect(result.stderr).not.toContain("mkfs.ext4");
  });
});
