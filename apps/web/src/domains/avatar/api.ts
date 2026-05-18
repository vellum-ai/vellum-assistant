/**
 * Avatar API functions for fetching character components and traits.
 *
 * These call daemon endpoints via the configured HeyAPI client singleton.
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

export async function fetchCharacterTraits(
  assistantId: string,
): Promise<CharacterTraits | null> {
  try {
    const { data, error, response } = await client.get({
      url: "/v1/assistants/{assistant_id}/avatar/character-traits",
      path: { assistant_id: assistantId },
    });
    assertHasResponse(response, error, "Failed to fetch character traits");
    if (!response.ok || !data) return null;
    if (!isCharacterTraits(data)) return null;
    return data;
  } catch {
    return null;
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
