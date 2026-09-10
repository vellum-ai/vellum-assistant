import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveNotificationAvatarPath } from "./notification-avatar-path";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HASH = new Bun.CryptoHasher("sha256").update(PNG).digest("hex");

const sender = {
  id: "assistant-1",
  name: "Ada",
  avatarPng: PNG,
  avatarHash: HASH,
};

let userDataDir: string;
let warnings: unknown[][];

const logger = { warn: (...args: unknown[]) => warnings.push(args) };

beforeEach(() => {
  userDataDir = mkdtempSync(path.join(tmpdir(), "vellum-avatar-path-"));
  warnings = [];
});

afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true });
});

describe("resolveNotificationAvatarPath", () => {
  test("stages the avatar and returns its path", () => {
    const file = resolveNotificationAvatarPath(sender, userDataDir, logger);

    expect(file).toBe(
      path.join(userDataDir, "notification-avatars", `${HASH}.png`),
    );
    expect(readFileSync(file!)).toEqual(PNG);
    expect(warnings).toEqual([]);
  });

  test("returns null without touching disk when there is no sender", () => {
    expect(
      resolveNotificationAvatarPath(undefined, userDataDir, logger),
    ).toBeNull();
    expect(warnings).toEqual([]);
  });

  test("logs and returns null when the avatar cannot be staged", () => {
    const file = resolveNotificationAvatarPath(
      { ...sender, avatarHash: "../../escape" },
      userDataDir,
      logger,
    );

    expect(file).toBeNull();
    expect(warnings.length).toBe(1);
    expect(String(warnings[0]?.[0])).toContain("notification avatar");
  });
});
