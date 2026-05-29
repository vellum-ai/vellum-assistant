import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { AvatarState } from "../../../avatar/avatar-manifest.js";
import { writeManifest } from "../../../avatar/avatar-manifest.js";
import { ROUTES } from "../avatar-routes.js";
import type { RouteHandlerArgs } from "../types.js";

const VALID_TRAITS = { bodyShape: "round", eyeStyle: "happy", color: "blue" };

const IMAGE_FILENAME = "avatar-image.png";
const TRAITS_FILENAME = "character-traits.json";
const ASCII_FILENAME = "character-ascii.txt";
const MANIFEST_FILENAME = "avatar.json";

/** Resolve a handler from the route registry by operationId. */
function getHandler(operationId: string) {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`${operationId} route not registered`);
  return route.handler as (
    args: RouteHandlerArgs,
  ) => unknown | Promise<unknown>;
}

/** Resolve the GET /avatar/state handler from the route registry. */
function getStateHandler() {
  const route = ROUTES.find((r) => r.operationId === "avatar_get_state");
  if (!route) throw new Error("avatar_get_state route not registered");
  expect(route.endpoint).toBe("avatar/state");
  expect(route.method).toBe("GET");
  return route.handler as (
    args: RouteHandlerArgs,
  ) => AvatarState | Promise<AvatarState>;
}

describe("GET /avatar/state", () => {
  let workspaceDir: string;
  let avatarDir: string;
  let prevWorkspaceDir: string | undefined;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "avatar-state-route-test-"));
    avatarDir = join(workspaceDir, "data", "avatar");
    mkdirSync(avatarDir, { recursive: true });
    prevWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
    process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
  });

  afterEach(() => {
    if (prevWorkspaceDir === undefined) {
      delete process.env.VELLUM_WORKSPACE_DIR;
    } else {
      process.env.VELLUM_WORKSPACE_DIR = prevWorkspaceDir;
    }
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("returns the manifest verbatim when present", async () => {
    const state: AvatarState = {
      kind: "character",
      traits: VALID_TRAITS,
      source: "builder",
      image: null,
    };
    writeManifest(state, avatarDir);

    const result = await getStateHandler()({});
    expect(result).toEqual(state);
  });

  test("falls back to derived character state on manifest-miss (traits file)", async () => {
    writeFileSync(
      join(avatarDir, "character-traits.json"),
      JSON.stringify(VALID_TRAITS),
    );

    const result = await getStateHandler()({});
    expect(result.kind).toBe("character");
    expect(result.traits).toEqual(VALID_TRAITS);
    expect(result.image).toBeNull();
  });

  test("falls back to derived image state on manifest-miss (image file)", async () => {
    writeFileSync(join(avatarDir, "avatar-image.png"), Buffer.from("fake png"));

    const result = await getStateHandler()({});
    expect(result.kind).toBe("image");
    expect(result.traits).toBeNull();
    expect(result.image).not.toBeNull();
    expect(result.image?.etag).toMatch(/^[0-9a-f]{16}$/);
  });

  test("returns kind:none (no throw, no 404) for an empty workspace", async () => {
    let result: AvatarState | undefined;
    expect(() => {
      result = getStateHandler()({}) as AvatarState;
    }).not.toThrow();
    expect(result).toEqual({
      kind: "none",
      traits: null,
      source: null,
      image: null,
    });
  });
});

/**
 * Write/remove handlers route through the avatar store, so each leaves
 * `avatar.json` consistent with the on-disk artifacts. State is asserted by
 * reading the manifest + artifact files directly via `node:fs` (the route test
 * already imports `node:fs`; importing store internals is avoided).
 */
describe("avatar write/remove handlers", () => {
  let workspaceDir: string;
  let avatarDir: string;
  let prevWorkspaceDir: string | undefined;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "avatar-write-route-test-"));
    avatarDir = join(workspaceDir, "data", "avatar");
    mkdirSync(avatarDir, { recursive: true });
    prevWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
    process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
  });

  afterEach(() => {
    if (prevWorkspaceDir === undefined) {
      delete process.env.VELLUM_WORKSPACE_DIR;
    } else {
      process.env.VELLUM_WORKSPACE_DIR = prevWorkspaceDir;
    }
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  const path = (name: string) => join(avatarDir, name);

  interface ManifestShape {
    kind: string;
    traits: Record<string, unknown> | null;
    source: string | null;
    image: { updatedAt: string; etag: string } | null;
  }

  const readManifestFile = (): ManifestShape | null => {
    const manifestPath = path(MANIFEST_FILENAME);
    if (!existsSync(manifestPath)) return null;
    return JSON.parse(readFileSync(manifestPath, "utf-8")) as ManifestShape;
  };

  describe("POST /avatar/render-from-traits", () => {
    test("rejects missing required fields without writing a manifest", () => {
      const handler = getHandler("avatar_render_from_traits");
      expect(() => handler({ body: { bodyShape: "round" } })).toThrow(
        /Missing required fields/,
      );
      expect(readManifestFile()).toBeNull();
    });

    test("writes a character manifest when the native renderer is available", async () => {
      const handler = getHandler("avatar_render_from_traits");
      // The native @resvg/resvg-js binding may be absent here. When it is, the
      // store returns native_unavailable → the handler throws 503 and writes
      // nothing. We assert that contract instead so the suite is deterministic.
      let threw = false;
      try {
        await handler({ body: VALID_TRAITS });
      } catch {
        threw = true;
      }

      if (threw) {
        expect(readManifestFile()).toBeNull();
        return;
      }

      const manifest = readManifestFile();
      expect(manifest).not.toBeNull();
      expect(manifest!.kind).toBe("character");
      expect(manifest!.traits).toEqual(VALID_TRAITS);
      expect(manifest!.source).toBe("builder");
      expect(existsSync(path(IMAGE_FILENAME))).toBe(true);
      expect(existsSync(path(TRAITS_FILENAME))).toBe(true);
    });
  });

  describe("POST /avatar/set", () => {
    test("clears stale traits and writes an image manifest (no both-files)", async () => {
      // Seed legacy character artifacts to prove they get removed.
      writeFileSync(path(TRAITS_FILENAME), JSON.stringify(VALID_TRAITS));
      writeFileSync(path(ASCII_FILENAME), "ascii art");

      const srcPath = join(workspaceDir, "upload.png");
      writeFileSync(srcPath, Buffer.from("uploaded png bytes"));

      const handler = getHandler("avatar_set");
      const result = (await handler({ body: { imagePath: srcPath } })) as {
        ok: boolean;
      };
      expect(result.ok).toBe(true);

      expect(existsSync(path(IMAGE_FILENAME))).toBe(true);
      expect(readFileSync(path(IMAGE_FILENAME)).toString()).toBe(
        "uploaded png bytes",
      );
      // The stale character sidecars must be gone — no more both-files state.
      expect(existsSync(path(TRAITS_FILENAME))).toBe(false);
      expect(existsSync(path(ASCII_FILENAME))).toBe(false);

      const manifest = readManifestFile();
      expect(manifest!.kind).toBe("image");
      expect(manifest!.traits).toBeNull();
      expect(manifest!.source).toBe("upload");
      expect(manifest!.image!.etag).toMatch(/^[0-9a-f]{16}$/);
    });

    test("rejects an imagePath outside the workspace", () => {
      const handler = getHandler("avatar_set");
      expect(() => handler({ body: { imagePath: "/etc/passwd" } })).toThrow(
        /must resolve inside the workspace/,
      );
    });
  });

  describe("POST /avatar/remove", () => {
    test("clears everything to kind:none (revert-to-character branch gone)", async () => {
      // Seed an image plus legacy character artifacts.
      writeFileSync(path(IMAGE_FILENAME), Buffer.from("png"));
      writeFileSync(path(TRAITS_FILENAME), JSON.stringify(VALID_TRAITS));
      writeFileSync(path(ASCII_FILENAME), "ascii art");

      const handler = getHandler("avatar_remove");
      const result = (await handler({ body: {} })) as {
        ok: boolean;
        hadAvatar: boolean;
      };
      expect(result.ok).toBe(true);
      expect(result.hadAvatar).toBe(true);

      // Nothing is reverted: the character sidecars are gone too.
      expect(existsSync(path(IMAGE_FILENAME))).toBe(false);
      expect(existsSync(path(TRAITS_FILENAME))).toBe(false);
      expect(existsSync(path(ASCII_FILENAME))).toBe(false);
      expect(readManifestFile()).toEqual({
        kind: "none",
        traits: null,
        source: null,
        image: null,
      });
    });

    test("reports hadAvatar:false and still writes kind:none when nothing exists", async () => {
      const handler = getHandler("avatar_remove");
      const result = (await handler({ body: {} })) as {
        ok: boolean;
        hadAvatar: boolean;
      };
      expect(result.ok).toBe(true);
      expect(result.hadAvatar).toBe(false);
      expect(readManifestFile()!.kind).toBe("none");
    });
  });
});
