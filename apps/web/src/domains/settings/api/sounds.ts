/**
 * Sounds API — binary file download via the generic workspace endpoint.
 *
 * Config and available-sounds listing use the generated SDK directly
 * (`soundsConfigGetOptions`, `soundsAvailableGetOptions`, etc.).
 * Individual sound file download still uses the generic workspace
 * content endpoint since the dedicated route returns metadata, not bytes.
 */

import { workspaceFileContentGet } from "@/generated/daemon/sdk.gen";
import { assertHasResponse } from "@/utils/api-errors";

import { validateSoundFilename } from "@/domains/settings/types/sounds";

const SOUNDS_DIR = "data/sounds";

export interface AvailableSound {
  label: string;
  filename: string;
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
