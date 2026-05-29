import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { AvatarState } from "../../../avatar/avatar-manifest.js";
import { writeManifest } from "../../../avatar/avatar-manifest.js";
import { ROUTES } from "../avatar-routes.js";
import type { RouteHandlerArgs } from "../types.js";

const VALID_TRAITS = { bodyShape: "round", eyeStyle: "happy", color: "blue" };

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
