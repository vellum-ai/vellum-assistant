/**
 * Avatar API functions for fetching character components and traits.
 *
 * Targets the gateway-proxied `/v1/assistants/{assistant_id}/...` namespace,
 * matching the platform implementation. The gateway runtime-proxy rewrites
 * `/v1/assistants/<id>/X` to `/v1/X` before forwarding to the daemon, which
 * registers avatar and workspace routes flat (`/v1/avatar/...`,
 * `/v1/workspace/...`).
 */
import { client } from "@/lib/api-client.js";
import { assertHasResponse } from "@/lib/api-errors.js";
import type { CharacterComponents, CharacterTraits } from "./types.js";
import { isCharacterTraits } from "./types.js";

export async function fetchCharacterComponents(
  assistantId: string,
): Promise<CharacterComponents | null> {
  try {
    const { data, error, response } = await client.get({
      url: "/v1/assistants/{assistant_id}/avatar/character-components",
      path: { assistant_id: assistantId },
    });
    assertHasResponse(response, error, "Failed to fetch character components");
    if (!response.ok || !data || typeof data !== "object") return null;
    return data as CharacterComponents;
  } catch {
    return null;
  }
}

interface WorkspaceFileResponse {
  content: string | null;
}

export async function fetchCharacterTraits(
  assistantId: string,
): Promise<CharacterTraits | null> {
  try {
    const { data, error, response } = await client.get({
      url: "/v1/assistants/{assistant_id}/workspace/file/",
      path: { assistant_id: assistantId },
      query: { path: "data/avatar/character-traits.json" },
    });
    assertHasResponse(response, error, "Failed to fetch character traits");
    if (!response.ok || !data || typeof data !== "object") return null;

    const content = (data as WorkspaceFileResponse).content;
    if (typeof content !== "string") return null;

    const parsed: unknown = JSON.parse(content);
    if (!isCharacterTraits(parsed)) return null;
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
    const { error, response } = await client.post({
      url: "/v1/assistants/{assistant_id}/avatar/render-from-traits",
      path: { assistant_id: assistantId },
      body: traits,
      headers: { "Content-Type": "application/json" },
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

    const { error: writeError, response: writeResponse } = await client.post({
      url: "/v1/assistants/{assistant_id}/workspace/write/",
      path: { assistant_id: assistantId },
      body: { path: "data/avatar/avatar-image.png", content: base64, encoding: "base64" },
      headers: { "Content-Type": "application/json" },
    });
    assertHasResponse(writeResponse, writeError, "Failed to upload avatar image");
    if (!writeResponse.ok) return false;

    await client.post({
      url: "/v1/assistants/{assistant_id}/workspace/delete/",
      path: { assistant_id: assistantId },
      body: { path: "data/avatar/character-traits.json" },
      headers: { "Content-Type": "application/json" },
    });

    return true;
  } catch {
    return false;
  }
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
