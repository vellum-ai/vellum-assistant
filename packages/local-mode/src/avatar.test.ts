import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readLockfileAssistantAvatar } from "./avatar";

describe("readLockfileAssistantAvatar", () => {
  const traits = { bodyShape: "round", eyeStyle: "dot", color: "#abc" };
  const imageMeta = { updatedAt: "2026-01-01T00:00:00.000Z", etag: "abc" };
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  const imageMaxBytes = 5 * 1024 * 1024;
  let tempDir: string;
  let lockfilePath: string;
  let instanceDir: string;
  let avatarDir: string;

  const env = { VELLUM_ENVIRONMENT: "production", XDG_DATA_HOME: "" };
  const read = (assistantId = "asst-1") =>
    readLockfileAssistantAvatar([lockfilePath], assistantId, env);

  const writeLockfileEntry = (
    resources?: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ): void => {
    fs.writeFileSync(
      lockfilePath,
      JSON.stringify({
        assistants: [
          {
            assistantId: "asst-1",
            cloud: "local",
            runtimeUrl: "http://127.0.0.1:1",
            resources,
            ...extra,
          },
        ],
        activeAssistant: "asst-1",
      }),
    );
  };
  const writeAvatarFile = (name: string, contents: string | Buffer): void => {
    fs.mkdirSync(avatarDir, { recursive: true });
    fs.writeFileSync(path.join(avatarDir, name), contents);
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-mode-avatar-"));
    env.XDG_DATA_HOME = path.join(tempDir, "data-home");
    lockfilePath = path.join(tempDir, "lockfile.json");
    instanceDir = path.join(tempDir, "instance");
    avatarDir = path.join(
      instanceDir,
      ".vellum",
      "workspace",
      "data",
      "avatar",
    );
    writeLockfileEntry({ instanceDir, gatewayPort: 1, daemonPort: 2 });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("manifest character returns its traits even when a raster exists", () => {
    writeAvatarFile(
      "avatar.json",
      JSON.stringify({ kind: "character", traits }),
    );
    writeAvatarFile("avatar-image.png", png);

    expect(read()).toEqual({
      ok: true,
      avatar: { kind: "character", traits },
    });
  });

  test("manifest image returns the PNG base64", () => {
    writeAvatarFile(
      "avatar.json",
      JSON.stringify({ kind: "image", image: imageMeta }),
    );
    writeAvatarFile("avatar-image.png", png);

    expect(read()).toEqual({
      ok: true,
      avatar: { kind: "image", imageBase64: png.toString("base64") },
    });
  });

  test("manifest none yields null despite sidecar files", () => {
    writeAvatarFile("avatar.json", JSON.stringify({ kind: "none" }));
    writeAvatarFile("character-traits.json", JSON.stringify(traits));
    writeAvatarFile("avatar-image.png", png);

    expect(read()).toEqual({ ok: true, avatar: null });
  });

  test("legacy: traits file wins over the raster", () => {
    writeAvatarFile("character-traits.json", JSON.stringify(traits));
    writeAvatarFile("avatar-image.png", png);

    expect(read()).toEqual({
      ok: true,
      avatar: { kind: "character", traits },
    });
  });

  test("legacy: PNG alone yields image", () => {
    writeAvatarFile("avatar-image.png", png);

    expect(read()).toEqual({
      ok: true,
      avatar: { kind: "image", imageBase64: png.toString("base64") },
    });
  });

  test("empty avatar dir yields null", () => {
    fs.mkdirSync(avatarDir, { recursive: true });

    expect(read()).toEqual({ ok: true, avatar: null });
  });

  test("missing lockfile entry yields null", () => {
    expect(read("asst-gone")).toEqual({ ok: true, avatar: null });
  });

  test("missing lockfile yields null", () => {
    fs.rmSync(lockfilePath);

    expect(read()).toEqual({ ok: true, avatar: null });
  });

  test("corrupt lockfile is a failure, not a conclusive none", () => {
    fs.writeFileSync(lockfilePath, "{ not json");

    expect(read()).toEqual({ ok: false, error: "lockfile unreadable" });
  });

  test("entry without an instanceDir reads the default instance dir", () => {
    writeLockfileEntry({ gatewayPort: 1, daemonPort: 2 });
    const defaultAvatarDir = path.join(
      env.XDG_DATA_HOME,
      "vellum",
      "assistants",
      "asst-1",
      ".vellum",
      "workspace",
      "data",
      "avatar",
    );
    fs.mkdirSync(defaultAvatarDir, { recursive: true });
    fs.writeFileSync(
      path.join(defaultAvatarDir, "character-traits.json"),
      JSON.stringify(traits),
    );

    expect(read()).toEqual({
      ok: true,
      avatar: { kind: "character", traits },
    });
  });

  test("entry without an instanceDir and no default workspace yields null", () => {
    writeLockfileEntry({ gatewayPort: 1, daemonPort: 2 });

    expect(read()).toEqual({ ok: true, avatar: null });
  });

  test("legacy lockfile entry with only baseDataDir resolves", () => {
    writeLockfileEntry(undefined, { baseDataDir: instanceDir });
    writeAvatarFile("character-traits.json", JSON.stringify(traits));

    expect(read()).toEqual({
      ok: true,
      avatar: { kind: "character", traits },
    });
  });

  test("oversized image is a failure, not a conclusive none", () => {
    writeAvatarFile(
      "avatar.json",
      JSON.stringify({ kind: "image", image: imageMeta }),
    );
    writeAvatarFile("avatar-image.png", Buffer.alloc(imageMaxBytes + 1));

    expect(read()).toEqual({ ok: false, error: "avatar image too large" });
  });

  test("image at exactly the cap is served", () => {
    writeAvatarFile(
      "avatar.json",
      JSON.stringify({ kind: "image", image: imageMeta }),
    );
    const image = Buffer.concat([
      png,
      Buffer.alloc(imageMaxBytes - png.length),
    ]);
    writeAvatarFile("avatar-image.png", image);

    expect(read()).toEqual({
      ok: true,
      avatar: { kind: "image", imageBase64: image.toString("base64") },
    });
  });

  test("manifest image whose bytes are not a raster is a failure", () => {
    writeAvatarFile(
      "avatar.json",
      JSON.stringify({ kind: "image", image: imageMeta }),
    );
    writeAvatarFile("avatar-image.png", Buffer.from("definitely not an image"));

    expect(read()).toEqual({ ok: false, error: "avatar image unreadable" });
  });

  test("manifest image whose PNG is a directory is a failure", () => {
    writeAvatarFile(
      "avatar.json",
      JSON.stringify({ kind: "image", image: imageMeta }),
    );
    fs.mkdirSync(path.join(avatarDir, "avatar-image.png"));

    expect(read()).toEqual({ ok: false, error: "avatar image unreadable" });
  });

  test("symlinked PNG is a failure even when it points inside the avatar dir", () => {
    writeAvatarFile(
      "avatar.json",
      JSON.stringify({ kind: "image", image: imageMeta }),
    );
    writeAvatarFile("real.png", png);
    fs.symlinkSync("real.png", path.join(avatarDir, "avatar-image.png"));

    expect(read()).toEqual({ ok: false, error: "avatar image unreadable" });
  });

  test("symlinked PNG escaping the workspace is a failure", () => {
    writeAvatarFile(
      "avatar.json",
      JSON.stringify({ kind: "image", image: imageMeta }),
    );
    const secret = path.join(tempDir, "secret.txt");
    fs.writeFileSync(secret, "host-only");
    fs.symlinkSync(secret, path.join(avatarDir, "avatar-image.png"));

    expect(read()).toEqual({ ok: false, error: "avatar image unreadable" });
  });

  test("symlinked avatar dir escaping the workspace is a failure", () => {
    const outside = path.join(tempDir, "outside");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "avatar-image.png"), png);
    fs.mkdirSync(path.dirname(avatarDir), { recursive: true });
    fs.symlinkSync(outside, avatarDir);

    expect(read()).toEqual({ ok: false, error: "avatar image unreadable" });
  });

  test("a symlink swapped in after the lstat check is still rejected at open", () => {
    writeAvatarFile(
      "avatar.json",
      JSON.stringify({ kind: "image", image: imageMeta }),
    );
    const secret = path.join(tempDir, "secret.txt");
    fs.writeFileSync(secret, "host-only");
    writeAvatarFile("real.png", png);
    fs.symlinkSync(secret, path.join(avatarDir, "avatar-image.png"));
    const realLstat = fs.lstatSync;
    const lstat = spyOn(fs, "lstatSync").mockImplementation(((
      _path: fs.PathLike,
    ) => realLstat(path.join(avatarDir, "real.png"))) as typeof fs.lstatSync);
    try {
      expect(read()).toEqual({ ok: false, error: "avatar image unreadable" });
    } finally {
      lstat.mockRestore();
    }
  });

  const swapAvatarDirForOutsideLink = (outside: string): void => {
    fs.renameSync(avatarDir, `${avatarDir}.moved`);
    fs.symlinkSync(outside, avatarDir);
  };
  const restoreAvatarDir = (): void => {
    fs.unlinkSync(avatarDir);
    fs.renameSync(`${avatarDir}.moved`, avatarDir);
  };
  const writeOutsideImage = (): string => {
    const outside = path.join(tempDir, "outside");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "avatar-image.png"), "host-only");
    return outside;
  };
  // Swap the validated dir for an outside symlink after the containment
  // check so lstat and open both see the outside file.
  const swapAtFirstLstat = (outside: string): { mockRestore(): void } => {
    const realLstat = fs.lstatSync;
    let swapped = false;
    return spyOn(fs, "lstatSync").mockImplementation(((file: fs.PathLike) => {
      if (!swapped) {
        swapped = true;
        swapAvatarDirForOutsideLink(outside);
      }
      return realLstat(file);
    }) as typeof fs.lstatSync);
  };

  test("an avatar dir swapped for an outside symlink after the containment check is rejected", () => {
    writeAvatarFile(
      "avatar.json",
      JSON.stringify({ kind: "image", image: imageMeta }),
    );
    writeAvatarFile("avatar-image.png", png);
    const lstat = swapAtFirstLstat(writeOutsideImage());
    try {
      expect(read()).toEqual({ ok: false, error: "avatar image unreadable" });
    } finally {
      lstat.mockRestore();
    }
  });

  test("an avatar dir swapped out before lstat and back after open is rejected", () => {
    writeAvatarFile(
      "avatar.json",
      JSON.stringify({ kind: "image", image: imageMeta }),
    );
    writeAvatarFile("avatar-image.png", png);
    const lstat = swapAtFirstLstat(writeOutsideImage());
    const realOpen = fs.openSync;
    const open = spyOn(fs, "openSync").mockImplementation(((
      file: fs.PathLike,
      flags: fs.OpenMode,
    ) => {
      const fd = realOpen(file, flags);
      restoreAvatarDir();
      return fd;
    }) as typeof fs.openSync);
    try {
      expect(read()).toEqual({ ok: false, error: "avatar image unreadable" });
    } finally {
      open.mockRestore();
      lstat.mockRestore();
    }
  });

  test("manifest image whose PNG is missing is a failure", () => {
    writeAvatarFile(
      "avatar.json",
      JSON.stringify({ kind: "image", image: imageMeta }),
    );

    expect(read()).toEqual({ ok: false, error: "avatar image unreadable" });
  });

  test("malformed manifest falls back to legacy inference", () => {
    writeAvatarFile("avatar.json", "{ not json");
    writeAvatarFile("character-traits.json", JSON.stringify(traits));

    expect(read()).toEqual({
      ok: true,
      avatar: { kind: "character", traits },
    });
  });

  test("manifest image without image metadata falls back to legacy inference", () => {
    writeAvatarFile("avatar.json", JSON.stringify({ kind: "image" }));
    writeAvatarFile("character-traits.json", JSON.stringify(traits));
    writeAvatarFile("avatar-image.png", png);

    expect(read()).toEqual({
      ok: true,
      avatar: { kind: "character", traits },
    });
  });

  test("manifest image with malformed image metadata falls back to legacy inference", () => {
    writeAvatarFile(
      "avatar.json",
      JSON.stringify({ kind: "image", image: { updatedAt: "" } }),
    );
    writeAvatarFile("character-traits.json", JSON.stringify(traits));

    expect(read()).toEqual({
      ok: true,
      avatar: { kind: "character", traits },
    });
  });

  test("manifest character with malformed traits is treated as absent", () => {
    writeAvatarFile(
      "avatar.json",
      JSON.stringify({ kind: "character", traits: { bodyShape: "round" } }),
    );

    expect(read()).toEqual({ ok: true, avatar: null });

    writeAvatarFile("avatar-image.png", png);
    expect(read()).toEqual({
      ok: true,
      avatar: { kind: "image", imageBase64: png.toString("base64") },
    });
  });
});
