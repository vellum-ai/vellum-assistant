/**
 * Sounds API functions for reading and writing the `data/sounds/config.json`
 * file and enumerating available sound files in the assistant workspace.
 *
 * Uses the generic workspace endpoints (`file/content`, `write`, `tree`,
 * `delete`) rather than a dedicated sounds API so the macOS and web clients
 * read from the exact same on-disk format.
 */

import {
  workspaceFileContentGet,
  workspaceTreeGet,
  workspaceWritePost,
} from "@/generated/daemon/sdk.gen";
import { assertHasResponse } from "@/utils/api-errors";

import {
  defaultSoundsConfig,
  displayLabelForFilename,
  hasSupportedExtension,
  normaliseSoundsConfig,
  validateSoundFilename,
  type SoundsConfig,
} from "@/domains/settings/types/sounds";

const CONFIG_PATH = "data/sounds/config.json";
const SOUNDS_DIR = "data/sounds";

export interface AvailableSound {
  label: string;
  filename: string;
}

export async function fetchSoundsConfig(
  assistantId: string,
): Promise<SoundsConfig> {
  try {
    const { data, error, response } = await workspaceFileContentGet({
      path: { assistant_id: assistantId },
      query: { path: CONFIG_PATH },
      parseAs: "blob",
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to fetch sounds config");

    if (!response.ok || !data) {
      return defaultSoundsConfig();
    }

    const text = await data.text();
    if (!text) {
      return defaultSoundsConfig();
    }

    try {
      const parsed: unknown = JSON.parse(text);
      return normaliseSoundsConfig(parsed);
    } catch {
      return defaultSoundsConfig();
    }
  } catch {
    return defaultSoundsConfig();
  }
}

export async function saveSoundsConfig(
  assistantId: string,
  config: SoundsConfig,
): Promise<void> {
  const payload = JSON.stringify(config, null, 2);
  const base64 = btoa(unescape(encodeURIComponent(payload)));

  const { error, response } = await workspaceWritePost({
    path: { assistant_id: assistantId },
    body: { path: CONFIG_PATH, content: base64, encoding: "base64" },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to save sounds config");
  if (!response.ok) {
    throw new Error(`Failed to save sounds config (status ${response.status})`);
  }
}

export async function listAvailableSounds(
  assistantId: string,
): Promise<AvailableSound[]> {
  try {
    const { data, error, response } = await workspaceTreeGet({
      path: { assistant_id: assistantId },
      query: { path: SOUNDS_DIR, showHidden: "true" },
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to list sound files");

    if (!response.ok || !data?.entries) {
      return [];
    }

    const sounds: AvailableSound[] = [];
    for (const entry of data.entries) {
      if (entry.type !== "file") continue;
      const name = entry.name;
      if (!name || name === "config.json") continue;
      if (!hasSupportedExtension(name)) continue;
      sounds.push({ label: displayLabelForFilename(name), filename: name });
    }
    sounds.sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
    );
    return sounds;
  } catch {
    return [];
  }
}

export async function fetchSoundFile(
  assistantId: string,
  filename: string,
): Promise<Blob | null> {
  if (!validateSoundFilename(filename)) {
    return null;
  }
  try {
    const { data, error, response } = await workspaceFileContentGet({
      path: { assistant_id: assistantId },
      query: { path: `${SOUNDS_DIR}/${filename}` },
      parseAs: "blob",
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to fetch sound file");
    if (!response.ok || !data) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}
