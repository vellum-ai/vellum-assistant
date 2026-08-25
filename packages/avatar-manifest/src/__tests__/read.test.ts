import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readWorkspaceAvatar } from "../read.js";

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
});
