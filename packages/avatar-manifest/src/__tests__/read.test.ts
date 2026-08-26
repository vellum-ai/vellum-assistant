import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AVATAR_SIDECAR_MAX_BYTES, readWorkspaceAvatar } from "../read.js";

const traits = { bodyShape: "round", eyeStyle: "dot", color: "#abc" };

describe("readWorkspaceAvatar", () => {
  let workspaceDir: string;
  let avatarDir: string;

  const write = (name: string, contents: string): void => {
    mkdirSync(avatarDir, { recursive: true });
    writeFileSync(join(avatarDir, name), contents);
  };

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "avatar-manifest-"));
    avatarDir = join(workspaceDir, "data", "avatar");
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("missing avatar dir yields none", () => {
    expect(readWorkspaceAvatar(workspaceDir)).toEqual({ kind: "none" });
  });

  test("manifest character returns its traits", () => {
    write("avatar.json", JSON.stringify({ kind: "character", traits }));
    write("avatar-image.png", "png");
    expect(readWorkspaceAvatar(workspaceDir)).toEqual({
      kind: "character",
      traits,
    });
  });

  test("image resolves to the PNG path", () => {
    write("avatar-image.png", "png");
    expect(readWorkspaceAvatar(workspaceDir)).toEqual({
      kind: "image",
      imagePath: join(avatarDir, "avatar-image.png"),
    });
  });

  test("corrupt manifest falls back to the traits sidecar", () => {
    write("avatar.json", "{ not json");
    write("character-traits.json", JSON.stringify(traits));
    expect(readWorkspaceAvatar(workspaceDir)).toEqual({
      kind: "character",
      traits,
    });
  });

  test("oversized sidecars are treated as absent", () => {
    const padded = JSON.stringify({
      kind: "character",
      traits,
      pad: "x".repeat(AVATAR_SIDECAR_MAX_BYTES),
    });
    write("avatar.json", padded);
    write("character-traits.json", JSON.stringify({ ...traits, pad: padded }));
    expect(readWorkspaceAvatar(workspaceDir)).toEqual({ kind: "none" });
  });

  test("a sidecar at the cap still reads", () => {
    const body = JSON.stringify({ kind: "character", traits, pad: "" });
    write(
      "avatar.json",
      body.replace(
        '"pad":""',
        `"pad":"${"x".repeat(AVATAR_SIDECAR_MAX_BYTES - body.length)}"`,
      ),
    );
    expect(readWorkspaceAvatar(workspaceDir)).toEqual({
      kind: "character",
      traits,
    });
  });

  test("a symlinked avatar dir is treated as absent", () => {
    const foreign = mkdtempSync(join(tmpdir(), "foreign-avatar-"));
    writeFileSync(
      join(foreign, "character-traits.json"),
      JSON.stringify({
        bodyShape: "blob",
        eyeStyle: "curious",
        color: "green",
      }),
    );
    mkdirSync(join(workspaceDir, "data"), { recursive: true });
    symlinkSync(foreign, avatarDir);
    expect(readWorkspaceAvatar(workspaceDir)).toEqual({ kind: "none" });
    rmSync(foreign, { recursive: true, force: true });
  });

  test("symlinked sidecars are treated as absent", () => {
    const outside = join(workspaceDir, "outside.json");
    writeFileSync(outside, JSON.stringify({ kind: "character", traits }));
    mkdirSync(avatarDir, { recursive: true });
    symlinkSync(outside, join(avatarDir, "avatar.json"));
    symlinkSync(outside, join(avatarDir, "character-traits.json"));
    expect(readWorkspaceAvatar(workspaceDir)).toEqual({ kind: "none" });
  });
});
