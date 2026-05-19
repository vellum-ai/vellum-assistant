/**
 * Avatar API functions for fetching character components and saving avatar traits.
 *
 * These functions call the assistant daemon's avatar endpoints via the
 * wildcard proxy (same pattern as fetchAssistantIdentity in lib/chat/api.ts).
 */

import { client } from "@/generated/api/client.gen.js";
import { assertHasResponse } from "@/lib/api/errors.js";
import "@/lib/vellum-api/client.js";

import type { CharacterComponents, CharacterTraits } from "@/lib/avatar/types.js";
import { isCharacterTraits } from "@/lib/avatar/types.js";

const SDK_BASE_OPTIONS =
  typeof window === "undefined"
    ? ({ baseUrl: "http://localhost" } as const)
    : ({} as const);

/**
 * Fetch the available character components (body shapes, eye styles, colors)
 * from the assistant daemon.
 */
export async function fetchCharacterComponents(
  assistantId: string,
): Promise<CharacterComponents | null> {
  try {
    const { data, error, response } = await client.get<CharacterComponents, unknown>({
      ...SDK_BASE_OPTIONS,
      url: "/v1/assistants/{assistant_id}/avatar/character-components",
      path: { assistant_id: assistantId },
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to fetch character components");

    if (!response.ok || !data || typeof data !== "object") {
      return null;
    }

    return data;
  } catch {
    return null;
  }
}

/**
 * Save character traits and trigger server-side avatar PNG rendering.
 * Returns true on success, false on failure.
 */
export async function saveCharacterTraits(
  assistantId: string,
  traits: CharacterTraits,
): Promise<boolean> {
  try {
    const { error, response } = await client.post<{ ok: boolean }, unknown>({
      ...SDK_BASE_OPTIONS,
      url: "/v1/assistants/{assistant_id}/avatar/render-from-traits",
      path: { assistant_id: assistantId },
      body: traits,
      headers: { "Content-Type": "application/json" },
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to save avatar traits");

    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Fetch the current avatar image URL for an assistant.
 * Returns the URL string or null if no avatar is set.
 */
export async function fetchAvatarImageUrl(
  assistantId: string,
): Promise<string | null> {
  try {
    const { data, error, response } = await client.get<Blob, unknown>({
      ...SDK_BASE_OPTIONS,
      url: "/v1/assistants/{assistant_id}/workspace/file/content/",
      path: { assistant_id: assistantId },
      query: { path: "data/avatar/avatar-image.png" },
      parseAs: "blob",
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to fetch avatar image");

    if (!response.ok || !data) {
      return null;
    }

    return URL.createObjectURL(data);
  } catch {
    return null;
  }
}

/**
 * Delete avatar files from the assistant workspace.
 * Removes both the rendered PNG and character traits JSON.
 * Returns true on success, false on failure.
 */
export async function deleteAvatar(
  assistantId: string,
): Promise<boolean> {
  try {
    const { error, response } = await client.post<unknown, unknown>({
      ...SDK_BASE_OPTIONS,
      url: "/v1/assistants/{assistant_id}/workspace/delete/",
      path: { assistant_id: assistantId },
      body: { path: "data/avatar" },
      headers: { "Content-Type": "application/json" },
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to delete avatar");
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Upload a custom avatar image (PNG bytes) to the assistant workspace.
 * Converts the file to base64 and writes it via the workspace/write endpoint,
 * then clears any existing character-traits so the custom image takes precedence.
 * Returns true on success, false on failure.
 */
export async function uploadAvatarImage(
  assistantId: string,
  file: File,
): Promise<boolean> {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const base64 = btoa(
      new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), ""),
    );

    // Write the image file
    const { error: writeError, response: writeResponse } = await client.post<unknown, unknown>({
      ...SDK_BASE_OPTIONS,
      url: "/v1/assistants/{assistant_id}/workspace/write/",
      path: { assistant_id: assistantId },
      body: { path: "data/avatar/avatar-image.png", content: base64, encoding: "base64" },
      headers: { "Content-Type": "application/json" },
      throwOnError: false,
    });
    assertHasResponse(writeResponse, writeError, "Failed to upload avatar image");
    if (!writeResponse.ok) {
      return false;
    }

    // Clear character traits so the custom image is used
    await client.post<unknown, unknown>({
      ...SDK_BASE_OPTIONS,
      url: "/v1/assistants/{assistant_id}/workspace/delete/",
      path: { assistant_id: assistantId },
      body: { path: "data/avatar/character-traits.json" },
      headers: { "Content-Type": "application/json" },
      throwOnError: false,
    });

    return true;
  } catch {
    return false;
  }
}

interface WorkspaceFileResponse {
  content: string | null;
}

export async function fetchCharacterTraits(
  assistantId: string,
): Promise<CharacterTraits | null> {
  try {
    const { data, error, response } = await client.get<WorkspaceFileResponse, unknown>({
      ...SDK_BASE_OPTIONS,
      url: "/v1/assistants/{assistant_id}/workspace/file/",
      path: { assistant_id: assistantId },
      query: { path: "data/avatar/character-traits.json" },
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to fetch character traits");

    if (!response.ok || !data || typeof data !== "object") {
      return null;
    }

    const content = data.content;
    if (typeof content !== "string") {
      return null;
    }

    const parsed: unknown = JSON.parse(content);
    if (!isCharacterTraits(parsed)) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}
