/**
 * Tests for the `__local/avatar/{id}` route the packaged `vellum client
 * --interface web` host serves. The chooser reads sibling avatars through it
 * when the Vite dev server (which has its own middleware) is not running.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { handleLocalEndpoints } from "../commands/client.js";

const traits = { bodyShape: "round", eyeStyle: "dot", color: "#123456" };
let tempDir: string;
let lockfilePath: string;
let instanceDir: string;

const dispatch = (
  pathname: string,
  init: { method?: string; remoteAddress?: string } = {},
) => {
  const url = new URL(`http://127.0.0.1:3000${pathname}`);
  const req = new Request(url, {
    method: init.method ?? "GET",
    headers: { host: "127.0.0.1:3000" },
  });
  return handleLocalEndpoints(
    req,
    url,
    { requestIP: () => ({ address: init.remoteAddress ?? "127.0.0.1" }) },
    { lockfilePaths: [lockfilePath], configDir: tempDir },
  );
};

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-client-avatar-"));
  lockfilePath = path.join(tempDir, "lockfile.json");
  instanceDir = path.join(tempDir, "instance");
  fs.writeFileSync(
    lockfilePath,
    JSON.stringify({
      assistants: [
        { assistantId: "asst-a", cloud: "local", resources: { instanceDir } },
      ],
      activeAssistant: "asst-a",
    }),
  );
  const avatarDir = path.join(
    instanceDir,
    ".vellum",
    "workspace",
    "data",
    "avatar",
  );
  fs.mkdirSync(avatarDir, { recursive: true });
  fs.writeFileSync(
    path.join(avatarDir, "avatar.json"),
    JSON.stringify({ kind: "character", traits }),
  );
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("vellum client __local/avatar", () => {
  test("serves the avatar on both the bare and SPA-prefixed routes", async () => {
    for (const route of [
      "/__local/avatar/asst-a",
      "/assistant/__local/avatar/asst-a",
    ]) {
      const res = await dispatch(route);
      expect(res?.status).toBe(200);
      expect(await res!.json()).toEqual({
        ok: true,
        avatar: { kind: "character", traits },
      });
    }
  });

  test("unknown assistant resolves to a null avatar", async () => {
    const res = await dispatch("/__local/avatar/nobody");
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ ok: true, avatar: null });
  });

  test("rejects non-loopback callers", async () => {
    const res = await dispatch("/__local/avatar/asst-a", {
      remoteAddress: "10.0.0.7",
    });
    expect(res?.status).toBe(403);
  });

  test("rejects non-GET methods", async () => {
    const res = await dispatch("/__local/avatar/asst-a", { method: "POST" });
    expect(res?.status).toBe(405);
  });
});
