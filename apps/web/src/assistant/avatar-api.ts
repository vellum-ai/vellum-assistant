/**
 * Avatar API functions for fetching character components and traits.
 *
 * Targets the gateway-proxied `/v1/assistants/{assistant_id}/...`
 * namespace. The gateway runtime-proxy rewrites `/v1/assistants/<id>/X`
 * to `/v1/X` before forwarding to the daemon, which registers avatar
 * and workspace routes flat (`/v1/avatar/...`, `/v1/workspace/...`).
 */
import { client } from "@/generated/api/client.gen";
import {
  avatarCharactercomponentsGet,
  avatarImagePost,
  avatarRenderfromtraitsPost,
  avatarStateGet,
  workspaceDeletePost,
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
    return data;
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

export async function fetchCharacterTraits(
  assistantId: string,
): Promise<CharacterTraits | null> {
  try {
    const { data, error, response } = await workspaceFileGet({
      path: { assistant_id: assistantId },
      query: { path: "data/avatar/character-traits.json" },
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to fetch character traits");
    if (!response.ok || !data) {
      return null;
    }

    const parsed: unknown = JSON.parse(data.content);
    if (!isCharacterTraits(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
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

export async function fetchAvatarImageUrl(
  assistantId: string,
): Promise<string | null> {
  try {
    const { data, error, response } = await client.get({
      url: "/v1/assistants/{assistant_id}/workspace/file/content/",
      path: { assistant_id: assistantId },
      query: { path: "data/avatar/avatar-image.png" },
      parseAs: "blob",
    });
    assertHasResponse(response, error, "Failed to fetch avatar image");
    if (!response.ok || !data) return null;
    return URL.createObjectURL(data as Blob);
  } catch {
    return null;
  }
}
