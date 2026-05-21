/**
 * Avatar API functions for fetching character components and traits.
 *
 * These call daemon endpoints via the configured HeyAPI client singleton.
 * The daemon serves a single assistant per process, so its avatar and
 * workspace routes are unscoped — they live at `/v1/avatar/...` and
 * `/v1/workspace/...`, not under `/v1/assistants/{assistant_id}/...`.
 */
import { client } from "@/lib/api-client.js";
import { assertHasResponse } from "@/lib/api-errors.js";
import type { CharacterComponents, CharacterTraits } from "./types.js";
import { isCharacterTraits } from "./types.js";

export async function fetchCharacterComponents(): Promise<CharacterComponents | null> {
  try {
    const { data, error, response } = await client.get({
      url: "/v1/avatar/character-components",
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

export async function fetchCharacterTraits(): Promise<CharacterTraits | null> {
  try {
    const { data, error, response } = await client.get({
      url: "/v1/workspace/file",
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
  traits: CharacterTraits,
): Promise<boolean> {
  try {
    const { error, response } = await client.post({
      url: "/v1/avatar/render-from-traits",
      body: traits,
      headers: { "Content-Type": "application/json" },
    });
    assertHasResponse(response, error, "Failed to save character traits");
    return response.ok;
  } catch {
    return false;
  }
}

export async function uploadAvatarImage(file: File): Promise<boolean> {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const base64 = btoa(
      new Uint8Array(arrayBuffer).reduce(
        (acc, byte) => acc + String.fromCharCode(byte),
        "",
      ),
    );

    const { error: writeError, response: writeResponse } = await client.post({
      url: "/v1/workspace/write",
      body: { path: "data/avatar/avatar-image.png", content: base64, encoding: "base64" },
      headers: { "Content-Type": "application/json" },
    });
    assertHasResponse(writeResponse, writeError, "Failed to upload avatar image");
    if (!writeResponse.ok) return false;

    await client.post({
      url: "/v1/workspace/delete",
      body: { path: "data/avatar/character-traits.json" },
      headers: { "Content-Type": "application/json" },
    });

    return true;
  } catch {
    return false;
  }
}

export async function fetchAvatarImageUrl(): Promise<string | null> {
  try {
    const { data, error, response } = await client.get({
      url: "/v1/workspace/file/content",
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
