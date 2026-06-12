/**
 * Sounds API — typed wrappers around the dedicated daemon sounds routes.
 *
 * Config and available-sounds listing use the generated SDK functions
 * (`soundsConfigGet`, `soundsConfigPut`, `soundsAvailableGet`).
 * Individual sound file download still uses the generic workspace
 * content endpoint since the dedicated route returns metadata, not bytes.
 */

import {
  soundsAvailableGet,
  soundsConfigGet,
  soundsConfigPut,
  workspaceFileContentGet,
} from "@/generated/daemon/sdk.gen";
import type { SoundsConfigGetResponse } from "@/generated/daemon/types.gen";
import { assertHasResponse } from "@/utils/api-errors";

import {
  defaultSoundsConfig,
  validateSoundFilename,
} from "@/domains/settings/types/sounds";

const SOUNDS_DIR = "data/sounds";

export type SoundsConfig = SoundsConfigGetResponse;

export async function fetchSoundsConfig(
  assistantId: string,
): Promise<SoundsConfig> {
  try {
    const { data, error, response } = await soundsConfigGet({
      path: { assistant_id: assistantId },
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to fetch sounds config");
    if (!response.ok || !data) {
      return defaultSoundsConfig();
    }
    return data;
  } catch {
    return defaultSoundsConfig();
  }
}

export async function saveSoundsConfig(
  assistantId: string,
  config: SoundsConfig,
): Promise<SoundsConfig> {
  const { data, error, response } = await soundsConfigPut({
    path: { assistant_id: assistantId },
    body: config,
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to save sounds config");
  if (!response.ok || !data) {
    throw new Error(`Failed to save sounds config (status ${response.status})`);
  }
  return data;
}

export interface AvailableSound {
  label: string;
  filename: string;
}

export async function listAvailableSounds(
  assistantId: string,
): Promise<AvailableSound[]> {
  try {
    const { data, error, response } = await soundsAvailableGet({
      path: { assistant_id: assistantId },
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to list sound files");
    if (!response.ok || !data?.sounds) {
      return [];
    }
    return data.sounds;
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
