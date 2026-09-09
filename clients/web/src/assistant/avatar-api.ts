/**
 * Avatar API functions for fetching character components and traits.
 *
 * Targets the gateway-proxied `/v1/assistants/{assistant_id}/...`
 * namespace. The gateway runtime-proxy rewrites `/v1/assistants/<id>/X`
 * to `/v1/X` before forwarding to the daemon, which registers avatar
 * and workspace routes flat (`/v1/avatar/...`, `/v1/workspace/...`).
 */
import {
  avatarAccentPost,
  avatarCharactercomponentsGet,
  avatarImagePost,
  avatarRenderfromtraitsPost,
  avatarStateGet,
  workspaceDeletePost,
  workspaceFileContentGet,
  workspaceFileGet,
  workspaceWritePost,
} from "@/generated/daemon/sdk.gen";
import { resolveSupportsAvatarStateManifest } from "@/lib/backwards-compat/avatar-state-manifest";
import type {
  AvatarState,
  CharacterComponents,
  CharacterTraits,
} from "@/types/avatar";
import { isAvatarState, isCharacterTraits } from "@/types/avatar";
import { assertHasResponse } from "@/utils/api-errors";

/**
 * An assistant that predates accents answers without the field; the manifest
 * shape promises it, so the null is filled in here.
 */
function withAccent(state: AvatarState): AvatarState {
  return { ...state, accent: state.accent ?? null };
}

/**
 * Fetch the authoritative avatar render manifest from the daemon's
 * `GET /avatar/state` endpoint.
 *
 * Returns `null` only on transport failure. A 200 response with
 * `{ kind: "none" }` is a valid state (an empty avatar), not `null`.
 */
export async function fetchAvatarState(
  assistantId: string,
): Promise<AvatarState | null> {
  try {
    const { data, error, response } = await avatarStateGet({
      path: { assistant_id: assistantId },
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to fetch avatar state");
    if (!response.ok || !isAvatarState(data)) {
      return null;
    }
    return withAccent(data);
  } catch {
    return null;
  }
}

/**
 * Set the accent over the current avatar (`#rrggbb`), or hand it back to the
 * automatic one with `null`. Resolves to the manifest as written, or null when
 * the request failed. Only reachable on assistants whose manifest already
 * carries an accent, which is how the route's presence is known.
 */
export async function saveAvatarAccent(
  assistantId: string,
  hex: string | null,
): Promise<AvatarState | null> {
  try {
    const { data, error, response } = await avatarAccentPost({
      path: { assistant_id: assistantId },
      body: { hex },
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to save avatar accent");
    if (!response.ok || !isAvatarState(data)) {
      return null;
    }
    return withAccent(data);
  } catch {
    return null;
  }
}

export async function fetchCharacterComponents(
  assistantId: string,
): Promise<CharacterComponents | null> {
  try {
    const { data, error, response } = await avatarCharactercomponentsGet({
      path: { assistant_id: assistantId },
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to fetch character components");
    if (!response.ok || !data) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

/**
 * A workspace sidecar read that keeps "the file is not there" (a 404, an
 * authoritative answer) apart from "the request failed" (inconclusive).
 */
export type AvatarFileResult<T> =
  { status: "found"; value: T } | { status: "absent" } | { status: "failed" };

function parseCharacterTraits(content: string): CharacterTraits | null {
  try {
    const parsed: unknown = JSON.parse(content);
    return isCharacterTraits(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** A sidecar the daemon serves but cannot be used (`parse` returns null) is as good as missing. */
async function readAvatarFile<D, T>(
  request: () => Promise<{ data?: D; error?: unknown; response?: Response }>,
  failureMessage: string,
  parse: (data: D) => T | null,
): Promise<AvatarFileResult<T>> {
  try {
    const { data, error, response } = await request();
    assertHasResponse(response, error, failureMessage);
    if (response.status === 404) {
      return { status: "absent" };
    }
    if (!response.ok || !data) {
      return { status: "failed" };
    }
    const value = parse(data);
    return value ? { status: "found", value } : { status: "absent" };
  } catch {
    return { status: "failed" };
  }
}

export function fetchCharacterTraitsResult(
  assistantId: string,
): Promise<AvatarFileResult<CharacterTraits>> {
  return readAvatarFile(
    () =>
      workspaceFileGet({
        path: { assistant_id: assistantId },
        query: { path: "data/avatar/character-traits.json" },
        throwOnError: false,
      }),
    "Failed to fetch character traits",
    (data) => parseCharacterTraits(data.content),
  );
}

/** {@link fetchCharacterTraitsResult} collapsed to a value; null for absent or failed. */
export async function fetchCharacterTraits(
  assistantId: string,
): Promise<CharacterTraits | null> {
  const result = await fetchCharacterTraitsResult(assistantId);
  return result.status === "found" ? result.value : null;
}

export async function saveCharacterTraits(
  assistantId: string,
  traits: CharacterTraits,
): Promise<boolean> {
  try {
    const { error, response } = await avatarRenderfromtraitsPost({
      path: { assistant_id: assistantId },
      body: traits,
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to save character traits");
    return response.ok;
  } catch {
    return false;
  }
}

export async function uploadAvatarImage(
  assistantId: string,
  file: File,
): Promise<boolean> {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const base64 = btoa(
      new Uint8Array(arrayBuffer).reduce(
        (acc, byte) => acc + String.fromCharCode(byte),
        "",
      ),
    );

    if (!(await resolveSupportsAvatarStateManifest())) {
      return uploadAvatarImageLegacy(assistantId, base64);
    }

    const { error, response } = await avatarImagePost({
      path: { assistant_id: assistantId },
      body: { content: base64, encoding: "base64" },
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to upload avatar image");
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Pre-manifest custom-image upload for assistants without the avatar
 * state manifest: write the PNG to the workspace and delete any
 * character-traits sidecar so the legacy file-existence inference resolves
 * to a custom image. Used as the fallback for {@link uploadAvatarImage};
 * see `lib/backwards-compat/avatar-state-manifest.ts`.
 */
async function uploadAvatarImageLegacy(
  assistantId: string,
  base64: string,
): Promise<boolean> {
  const { error: writeError, response: writeResponse } =
    await workspaceWritePost({
      path: { assistant_id: assistantId },
      body: {
        path: "data/avatar/avatar-image.png",
        content: base64,
        encoding: "base64",
      },
      throwOnError: false,
    });
  assertHasResponse(writeResponse, writeError, "Failed to upload avatar image");
  if (!writeResponse.ok) {
    return false;
  }

  await workspaceDeletePost({
    path: { assistant_id: assistantId },
    body: { path: "data/avatar/character-traits.json" },
    throwOnError: false,
  });

  return true;
}

export function fetchAvatarImageUrlResult(
  assistantId: string,
): Promise<AvatarFileResult<string>> {
  return readAvatarFile(
    () =>
      workspaceFileContentGet({
        path: { assistant_id: assistantId },
        query: { path: "data/avatar/avatar-image.png" },
        parseAs: "blob",
        throwOnError: false,
      }),
    "Failed to fetch avatar image",
    (data) => URL.createObjectURL(data),
  );
}
