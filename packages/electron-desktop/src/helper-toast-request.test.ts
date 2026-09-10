import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildHelperToastRequest } from "./helper-toast-request";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HASH = new Bun.CryptoHasher("sha256").update(PNG).digest("hex");

const sender = {
  id: "assistant-1",
  name: "Ada",
  avatarPng: PNG,
  avatarHash: HASH,
};

const options = {
  title: "Weekly review",
  body: "Three items need you",
  silent: false,
  actions: [{ type: "button" as const, text: "View" }],
};

let userDataDir: string;
let warnings: unknown[][];

const logger = { warn: (...args: unknown[]) => warnings.push(args) };

const build = (
  overrides: Partial<typeof options> & { sender?: typeof sender } = {},
) =>
  buildHelperToastRequest(
    { ...options, ...overrides },
    { token: "toast-1", userDataDir, logger },
  );

beforeEach(() => {
  userDataDir = mkdtempSync(path.join(tmpdir(), "vellum-helper-toast-"));
  warnings = [];
});

afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true });
});

describe("buildHelperToastRequest", () => {
  test("a sender takes the title and stages the avatar", () => {
    expect(build({ sender })).toEqual({
      token: "toast-1",
      title: "Ada",
      subtitle: "Weekly review",
      body: "Three items need you",
      actions: [{ text: "View" }],
      avatarPath: path.join(userDataDir, "notification-avatars", `${HASH}.png`),
    });
    expect(warnings).toEqual([]);
  });

  test("without a sender the conversation title stays and no picture is sent", () => {
    expect(build()).toEqual({
      token: "toast-1",
      title: "Weekly review",
      body: "Three items need you",
      actions: [{ text: "View" }],
    });
  });

  test("an unstageable avatar falls back to the plain toast", () => {
    const request = build({
      sender: { ...sender, avatarHash: "../../escape" },
    });

    expect(request).toEqual({
      token: "toast-1",
      title: "Weekly review",
      body: "Three items need you",
      actions: [{ text: "View" }],
    });
    expect(warnings.length).toBe(1);
  });

  test("actions carry only their text", () => {
    expect(
      build({
        actions: [
          { type: "button", text: "Allow" },
          { type: "button", text: "Deny" },
        ],
      }).actions,
    ).toEqual([{ text: "Allow" }, { text: "Deny" }]);
  });
});
