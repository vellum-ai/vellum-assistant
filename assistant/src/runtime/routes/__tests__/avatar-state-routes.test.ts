import {
  chmodSync,
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

  test("self-heals derived character state on manifest-miss (traits file) and persists it", async () => {
    writeFileSync(
      join(avatarDir, "character-traits.json"),
      JSON.stringify(VALID_TRAITS),
    );
    expect(existsSync(join(avatarDir, MANIFEST_FILENAME))).toBe(false);

    const result = await getStateHandler()({});
    expect(result.kind).toBe("character");
    expect(result.traits).toEqual(VALID_TRAITS);
    expect(result.image).toBeNull();

    // Self-heal: the derived state is now persisted so subsequent reads hit
    // the manifest directly rather than re-inferring from legacy files.
    const persisted = JSON.parse(
      readFileSync(join(avatarDir, MANIFEST_FILENAME), "utf-8"),
    ) as AvatarState;
    expect(persisted).toEqual(result);
  });

  test("self-heals derived image state on manifest-miss (image file) and persists it", async () => {
    writeFileSync(join(avatarDir, "avatar-image.png"), Buffer.from("fake png"));
    expect(existsSync(join(avatarDir, MANIFEST_FILENAME))).toBe(false);

    const result = await getStateHandler()({});
    expect(result.kind).toBe("image");
    expect(result.traits).toBeNull();
    expect(result.image).not.toBeNull();
    expect(result.image?.etag).toMatch(/^[0-9a-f]{16}$/);

    const persisted = JSON.parse(
      readFileSync(join(avatarDir, MANIFEST_FILENAME), "utf-8"),
    ) as AvatarState;
    expect(persisted).toEqual(result);
  });

  test("still returns derived state when the self-heal persist fails (read-only workspace)", async () => {
    // Seed a legacy traits file so derivation yields a character state, then make
    // the avatar dir read-only so writeManifest() throws. The handler must
    // swallow the persist failure and still return the derived state (no 500).
    writeFileSync(
      join(avatarDir, "character-traits.json"),
      JSON.stringify(VALID_TRAITS),
    );
    expect(existsSync(join(avatarDir, MANIFEST_FILENAME))).toBe(false);

    chmodSync(avatarDir, 0o555);
    try {
      let result: AvatarState | undefined;
      expect(() => {
        result = getStateHandler()({}) as AvatarState;
      }).not.toThrow();
      expect(result!.kind).toBe("character");
      expect(result!.traits).toEqual(VALID_TRAITS);
      // Persist failed, so no manifest was written.
      expect(existsSync(join(avatarDir, MANIFEST_FILENAME))).toBe(false);
    } finally {
      // Restore write perms so afterEach can clean up the temp dir.
      chmodSync(avatarDir, 0o755);
    }
  });

  test("returns kind:none WITHOUT persisting a manifest for an empty workspace (no throw, no 404)", async () => {
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

    // `none` is deliberately NOT persisted — the workspace stays manifest-less
    // so a later legacy sidecar write is still picked up by the next self-heal.
    expect(existsSync(join(avatarDir, MANIFEST_FILENAME))).toBe(false);
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

  describe("POST /avatar/image", () => {
    // Minimal valid PNG signature followed by enough bytes to clear the
    // 12-byte sniff floor. The handler only checks the magic bytes.
    const PNG_BYTES = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    ]);

    test("writes an image manifest and clears stale traits from base64", async () => {
      // Seed legacy character artifacts to prove they get removed.
      writeFileSync(path(TRAITS_FILENAME), JSON.stringify(VALID_TRAITS));
      writeFileSync(path(ASCII_FILENAME), "ascii art");

      const handler = getHandler("avatar_upload_image");
      const result = (await handler({
        body: { content: PNG_BYTES.toString("base64"), encoding: "base64" },
      })) as { ok: boolean };
      expect(result.ok).toBe(true);

      expect(existsSync(path(IMAGE_FILENAME))).toBe(true);
      expect(readFileSync(path(IMAGE_FILENAME))).toEqual(PNG_BYTES);
      // The stale character sidecars must be gone — no both-files state.
      expect(existsSync(path(TRAITS_FILENAME))).toBe(false);
      expect(existsSync(path(ASCII_FILENAME))).toBe(false);

      const manifest = readManifestFile();
      expect(manifest!.kind).toBe("image");
      expect(manifest!.traits).toBeNull();
      expect(manifest!.source).toBe("upload");
      expect(manifest!.image!.etag).toMatch(/^[0-9a-f]{16}$/);
    });

    test("accepts a base64 payload without an explicit encoding field", async () => {
      const handler = getHandler("avatar_upload_image");
      const result = (await handler({
        body: { content: PNG_BYTES.toString("base64") },
      })) as { ok: boolean };
      expect(result.ok).toBe(true);
      expect(readManifestFile()!.kind).toBe("image");
    });

    test("rejects a missing content field with 400 and writes no manifest", () => {
      const handler = getHandler("avatar_upload_image");
      expect(() => handler({ body: {} })).toThrow(/content/);
      expect(readManifestFile()).toBeNull();
    });

    test("rejects a non-base64 / non-image payload with 400", () => {
      const handler = getHandler("avatar_upload_image");
      // Valid base64 but decodes to plain text — not a supported image.
      expect(() =>
        handler({
          body: { content: Buffer.from("not an image").toString("base64") },
        }),
      ).toThrow(/PNG|JPEG|GIF|WEBP|image/);
      expect(readManifestFile()).toBeNull();
    });

    test("rejects an unsupported encoding with 400", () => {
      const handler = getHandler("avatar_upload_image");
      expect(() =>
        handler({
          body: { content: PNG_BYTES.toString("base64"), encoding: "hex" },
        }),
      ).toThrow(/encoding/);
      expect(readManifestFile()).toBeNull();
    });

    test("rejects malformed base64 (valid image prefix + illegal chars) with 400", () => {
      const handler = getHandler("avatar_upload_image");
      // A valid PNG prefix followed by characters outside the base64 alphabet.
      // Without strict validation, Buffer.from(.., "base64") would silently
      // drop the illegal suffix and decode a truncated-but-PNG-magic buffer,
      // accepting a corrupt avatar. Strict validation must reject it up front.
      const malformed = `${PNG_BYTES.toString("base64")}!!!@@@***`;
      expect(() => handler({ body: { content: malformed } })).toThrow(
        /valid base64/,
      );
      expect(existsSync(path(IMAGE_FILENAME))).toBe(false);
      expect(readManifestFile()).toBeNull();
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
      // none == absence: the manifest is deleted, not written as kind:none.
      expect(readManifestFile()).toBeNull();
      // A subsequent read still derives kind:none for the empty workspace.
      expect((getStateHandler()({}) as AvatarState).kind).toBe("none");
    });

    test("reports hadAvatar:true for a character-only workspace (traits, no PNG)", async () => {
      // A configured native character with no rendered PNG is still an avatar.
      // hadAvatar is derived from the manifest kind, not PNG existence, so the
      // clear correctly reports that a configured character was removed.
      const state: AvatarState = {
        kind: "character",
        traits: VALID_TRAITS,
        source: "builder",
        image: null,
      };
      writeManifest(state, avatarDir);
      writeFileSync(path(TRAITS_FILENAME), JSON.stringify(VALID_TRAITS));
      expect(existsSync(path(IMAGE_FILENAME))).toBe(false);

      const handler = getHandler("avatar_remove");
      const result = (await handler({ body: {} })) as {
        ok: boolean;
        hadAvatar: boolean;
      };
      expect(result.ok).toBe(true);
      expect(result.hadAvatar).toBe(true);
      expect(existsSync(path(TRAITS_FILENAME))).toBe(false);
      // none == absence: the manifest is deleted, and a read derives none.
      expect(readManifestFile()).toBeNull();
      expect((getStateHandler()({}) as AvatarState).kind).toBe("none");
    });

    test("reports hadAvatar:false and leaves no manifest when nothing exists", async () => {
      const handler = getHandler("avatar_remove");
      const result = (await handler({ body: {} })) as {
        ok: boolean;
        hadAvatar: boolean;
      };
      expect(result.ok).toBe(true);
      expect(result.hadAvatar).toBe(false);
      expect(readManifestFile()).toBeNull();
    });
  });
});

/**
 * `avatar/get` is the raster accessor (CLI / dock / notifications). Its
 * precedence is now driven by the manifest (falling back to legacy derivation),
 * not by image-first file existence. State is set up by writing the manifest +
 * artifacts on disk and asserted via the handler's return shape.
 */
describe("GET /avatar/get (manifest-driven precedence)", () => {
  let workspaceDir: string;
  let avatarDir: string;
  let prevWorkspaceDir: string | undefined;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "avatar-get-route-test-"));
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

  interface GetResult {
    exists: boolean;
    path?: string;
    base64?: string;
  }

  test("returns the PNG for an image manifest", () => {
    writeFileSync(path(IMAGE_FILENAME), Buffer.from("png bytes"));
    const state: AvatarState = {
      kind: "image",
      traits: null,
      source: "upload",
      image: { updatedAt: new Date().toISOString(), etag: "deadbeefdeadbeef" },
    };
    writeManifest(state, avatarDir);

    const result = getHandler("avatar_get")({}) as GetResult;
    expect(result.exists).toBe(true);
    expect(result.path).toBe(path(IMAGE_FILENAME));
  });

  test("returns base64 for an image manifest when format=base64", () => {
    writeFileSync(path(IMAGE_FILENAME), Buffer.from("png bytes"));
    const state: AvatarState = {
      kind: "image",
      traits: null,
      source: "upload",
      image: { updatedAt: new Date().toISOString(), etag: "deadbeefdeadbeef" },
    };
    writeManifest(state, avatarDir);

    const result = getHandler("avatar_get")({
      queryParams: { format: "base64" },
    }) as GetResult;
    expect(result.exists).toBe(true);
    expect(result.base64).toBe(Buffer.from("png bytes").toString("base64"));
    expect(result.path).toBeUndefined();
  });

  test("returns the existing raster for a character manifest", () => {
    // The builder writes the rendered PNG; assert the accessor returns it
    // without needing to re-render (the manifest says character).
    writeFileSync(path(IMAGE_FILENAME), Buffer.from("rendered character png"));
    const state: AvatarState = {
      kind: "character",
      traits: VALID_TRAITS,
      source: "builder",
      image: null,
    };
    writeManifest(state, avatarDir);

    const result = getHandler("avatar_get")({}) as GetResult;
    expect(result.exists).toBe(true);
    expect(result.path).toBe(path(IMAGE_FILENAME));
  });

  test("manifest precedence wins over file order: a character manifest is honored even when a PNG is present", () => {
    // Both a PNG and traits are on disk, but the manifest declares character.
    // The pre-manifest accessor was image-first; precedence is now the manifest.
    writeFileSync(path(IMAGE_FILENAME), Buffer.from("rendered character png"));
    writeFileSync(path(TRAITS_FILENAME), JSON.stringify(VALID_TRAITS));
    const state: AvatarState = {
      kind: "character",
      traits: VALID_TRAITS,
      source: "builder",
      image: null,
    };
    writeManifest(state, avatarDir);

    const result = getHandler("avatar_get")({}) as GetResult;
    expect(result.exists).toBe(true);
    expect(result.path).toBe(path(IMAGE_FILENAME));
  });

  test("returns exists:false for a none manifest", () => {
    writeManifest(
      { kind: "none", traits: null, source: null, image: null },
      avatarDir,
    );

    const result = getHandler("avatar_get")({}) as GetResult;
    expect(result.exists).toBe(false);
    expect(result.path).toBeUndefined();
  });

  test("self-heals from legacy files when no manifest exists (image file) and persists the manifest", () => {
    writeFileSync(path(IMAGE_FILENAME), Buffer.from("png bytes"));
    expect(existsSync(path(MANIFEST_FILENAME))).toBe(false);

    const result = getHandler("avatar_get")({}) as GetResult;
    expect(result.exists).toBe(true);
    expect(result.path).toBe(path(IMAGE_FILENAME));

    // Self-heal: the manifest is now written so the next read is manifest-only.
    const persisted = JSON.parse(
      readFileSync(path(MANIFEST_FILENAME), "utf-8"),
    ) as AvatarState;
    expect(persisted.kind).toBe("image");
  });

  test("returns exists:false for an empty workspace (no manifest, no files)", () => {
    const result = getHandler("avatar_get")({}) as GetResult;
    expect(result.exists).toBe(false);
  });

  test("rejects an invalid format", () => {
    expect(() =>
      getHandler("avatar_get")({ queryParams: { format: "bmp" } }),
    ).toThrow(/Invalid format/);
  });
});
