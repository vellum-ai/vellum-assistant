/**
 * Tests for `fetchAvatarState` and the `isAvatarState` type guard.
 *
 * Spies on `client.get` rather than `mock.module`-ing the whole SDK,
 * matching the pattern in `compaction-trail-fetch.test.ts` — keeps the
 * module registry clean for sibling test files.
 *
 * What's pinned:
 *   - The guard accepts every valid `kind` and rejects malformed payloads.
 *   - A 200 `{ kind: "none" }` is a VALID state, not `null`.
 *   - `fetchAvatarState` returns `null` only on transport failure (network
 *     throw, non-2xx, or a payload that fails validation).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { client } from "@/generated/daemon/client.gen";
import { MIN_VERSION } from "@/lib/backwards-compat/avatar-state-manifest";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import type { AvatarState } from "@/types/avatar";
import { isAvatarState } from "@/types/avatar";

import { fetchAvatarState, uploadAvatarImage } from "./avatar-api";

const CHARACTER_STATE: AvatarState = {
  kind: "character",
  traits: { bodyShape: "round", eyeStyle: "happy", color: "#123456" },
  source: "builder",
  image: null,
};

const IMAGE_STATE: AvatarState = {
  kind: "image",
  traits: null,
  source: "upload",
  image: { updatedAt: "2026-05-29T00:00:00Z", etag: "abc123" },
};

const NONE_STATE: AvatarState = {
  kind: "none",
  traits: null,
  source: null,
  image: null,
};

describe("isAvatarState", () => {
  test("accepts a character state", () => {
    expect(isAvatarState(CHARACTER_STATE)).toBe(true);
  });

  test("accepts an image state", () => {
    expect(isAvatarState(IMAGE_STATE)).toBe(true);
  });

  test("accepts a none state", () => {
    expect(isAvatarState(NONE_STATE)).toBe(true);
  });

  test("rejects non-objects", () => {
    expect(isAvatarState(null)).toBe(false);
    expect(isAvatarState(undefined)).toBe(false);
    expect(isAvatarState("none")).toBe(false);
    expect(isAvatarState(42)).toBe(false);
  });

  test("rejects an unknown kind", () => {
    expect(isAvatarState({ ...NONE_STATE, kind: "default" })).toBe(false);
  });

  test("rejects malformed traits", () => {
    expect(
      isAvatarState({ ...CHARACTER_STATE, traits: { bodyShape: "round" } }),
    ).toBe(false);
  });

  test("rejects malformed image meta", () => {
    expect(isAvatarState({ ...IMAGE_STATE, image: { updatedAt: "now" } })).toBe(
      false,
    );
  });

  test("rejects an invalid source", () => {
    expect(isAvatarState({ ...NONE_STATE, source: "magic" })).toBe(false);
  });
});

type CapturedGetOptions = {
  url: string;
  path?: Record<string, unknown>;
};

let captured: CapturedGetOptions | null = null;
const originalGet = client.get;

function stubGet(result: {
  data: unknown;
  error: unknown;
  response: Response;
}): void {
  captured = null;
  client.get = mock(async (options: CapturedGetOptions) => {
    captured = options;
    return result;
  }) as typeof client.get;
}

function okResponse(): Response {
  return new Response(null, { status: 200 });
}

function errorResponse(status: number): Response {
  return new Response(null, { status });
}

afterEach(() => {
  client.get = originalGet;
  captured = null;
});

describe("fetchAvatarState", () => {
  test("requests the avatar/state endpoint with the assistant id", async () => {
    stubGet({ data: NONE_STATE, error: undefined, response: okResponse() });

    await fetchAvatarState("asst-1");

    expect(captured?.url).toBe("/v1/assistants/{assistant_id}/avatar/state");
    expect(captured?.path).toEqual({ assistant_id: "asst-1" });
  });

  test("returns a typed character state", async () => {
    stubGet({
      data: CHARACTER_STATE,
      error: undefined,
      response: okResponse(),
    });

    const result = await fetchAvatarState("asst-1");

    expect(result).toEqual(CHARACTER_STATE);
  });

  test("returns kind:none as a valid state, not null", async () => {
    stubGet({ data: NONE_STATE, error: undefined, response: okResponse() });

    const result = await fetchAvatarState("asst-1");

    expect(result).toEqual(NONE_STATE);
  });

  test("returns null on a non-2xx response", async () => {
    stubGet({
      data: undefined,
      error: { detail: "boom" },
      response: errorResponse(500),
    });

    expect(await fetchAvatarState("asst-1")).toBeNull();
  });

  test("returns null when the payload fails validation", async () => {
    stubGet({
      data: { kind: "bogus" },
      error: undefined,
      response: okResponse(),
    });

    expect(await fetchAvatarState("asst-1")).toBeNull();
  });

  test("returns null on a transport throw", async () => {
    client.get = mock(() =>
      Promise.reject(new Error("network down")),
    ) as typeof client.get;

    expect(await fetchAvatarState("asst-1")).toBeNull();
  });
});

type CapturedPostOptions = {
  url: string;
  path?: Record<string, unknown>;
  body?: Record<string, unknown>;
};

let capturedPosts: CapturedPostOptions[] = [];
const originalPost = client.post;

function stubPost(result: { error: unknown; response: Response }): void {
  capturedPosts = [];
  client.post = mock(async (options: CapturedPostOptions) => {
    capturedPosts.push(options);
    return result;
  }) as typeof client.post;
}

function pngFile(): File {
  return new File([new Uint8Array([137, 80, 78, 71])], "avatar.png", {
    type: "image/png",
  });
}

afterEach(() => {
  client.post = originalPost;
  capturedPosts = [];
  useAssistantIdentityStore.getState().clearIdentity();
});

describe("uploadAvatarImage (manifest assistants)", () => {
  beforeEach(() => {
    useAssistantIdentityStore.getState().setIdentity("test-asst", MIN_VERSION);
  });

  test("POSTs base64 content to the single avatar/image endpoint", async () => {
    stubPost({ error: undefined, response: okResponse() });

    const result = await uploadAvatarImage("asst-1", pngFile());

    expect(result).toBe(true);
    expect(capturedPosts).toHaveLength(1);

    const post = capturedPosts[0];
    expect(post?.url).toBe("/v1/assistants/{assistant_id}/avatar/image");
    expect(post?.path).toEqual({ assistant_id: "asst-1" });
    expect(post?.body).toMatchObject({
      content: btoa("\x89PNG"),
      encoding: "base64",
    });
  });

  test("does not write or delete workspace files", async () => {
    stubPost({ error: undefined, response: okResponse() });

    await uploadAvatarImage("asst-1", pngFile());

    for (const post of capturedPosts) {
      expect(post.url).not.toContain("workspace/write");
      expect(post.url).not.toContain("workspace/delete");
    }
  });

  test("returns false on a non-2xx response", async () => {
    stubPost({ error: { detail: "boom" }, response: errorResponse(500) });

    expect(await uploadAvatarImage("asst-1", pngFile())).toBe(false);
  });

  test("returns false on a transport throw", async () => {
    client.post = mock(() =>
      Promise.reject(new Error("network down")),
    ) as typeof client.post;

    expect(await uploadAvatarImage("asst-1", pngFile())).toBe(false);
  });
});

describe("uploadAvatarImage (pre-manifest assistants)", () => {
  beforeEach(() => {
    useAssistantIdentityStore.getState().setIdentity("test-asst", "0.8.6");
  });

  test("writes the PNG then deletes the traits sidecar via workspace routes", async () => {
    stubPost({ error: undefined, response: okResponse() });

    const result = await uploadAvatarImage("asst-1", pngFile());

    expect(result).toBe(true);
    expect(capturedPosts).toHaveLength(2);

    const write = capturedPosts[0];
    expect(write?.url).toBe("/v1/assistants/{assistant_id}/workspace/write");
    expect(write?.path).toEqual({ assistant_id: "asst-1" });
    expect(write?.body).toMatchObject({
      path: "data/avatar/avatar-image.png",
      content: btoa("\x89PNG"),
      encoding: "base64",
    });

    const del = capturedPosts[1];
    expect(del?.url).toBe("/v1/assistants/{assistant_id}/workspace/delete");
    expect(del?.body).toMatchObject({
      path: "data/avatar/character-traits.json",
    });

    // The new single-shot endpoint must never be hit on old assistants.
    for (const post of capturedPosts) {
      expect(post.url).not.toContain("avatar/image");
    }
  });

  test("returns false and skips the delete when the write fails", async () => {
    stubPost({ error: { detail: "boom" }, response: errorResponse(500) });

    expect(await uploadAvatarImage("asst-1", pngFile())).toBe(false);
    expect(capturedPosts).toHaveLength(1);
    expect(capturedPosts[0]?.url).toBe(
      "/v1/assistants/{assistant_id}/workspace/write",
    );
  });
});

describe("uploadAvatarImage (version unhydrated at upload time)", () => {
  test("waits for the version to hydrate before choosing the manifest path", async () => {
    // Onboarding seeds an assistant with a still-null version. A legacy
    // file write here would be shadowed by a manifest-capable daemon's
    // `avatar.json`, so the upload must wait for the real version first.
    useAssistantIdentityStore.getState().clearIdentity();
    stubPost({ error: undefined, response: okResponse() });

    const pending = uploadAvatarImage("asst-1", pngFile());

    // Nothing is sent while the version is unknown.
    await Promise.resolve();
    expect(capturedPosts).toHaveLength(0);

    useAssistantIdentityStore.getState().setIdentity("test-asst", MIN_VERSION);

    expect(await pending).toBe(true);
    expect(capturedPosts).toHaveLength(1);
    expect(capturedPosts[0]?.url).toBe(
      "/v1/assistants/{assistant_id}/avatar/image",
    );
  });

  test("takes the legacy path once the version resolves below the cutover", async () => {
    useAssistantIdentityStore.getState().clearIdentity();
    stubPost({ error: undefined, response: okResponse() });

    const pending = uploadAvatarImage("asst-1", pngFile());
    await Promise.resolve();
    expect(capturedPosts).toHaveLength(0);

    useAssistantIdentityStore.getState().setIdentity("test-asst", "0.8.6");

    expect(await pending).toBe(true);
    expect(capturedPosts.map((post) => post.url)).toEqual([
      "/v1/assistants/{assistant_id}/workspace/write",
      "/v1/assistants/{assistant_id}/workspace/delete",
    ]);
  });
});
