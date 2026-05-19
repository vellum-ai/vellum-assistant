/**
 * Sounds API functions for reading and writing the `data/sounds/config.json`
 * file and enumerating available sound files in the assistant workspace.
 *
 * Uses the generic workspace endpoints (`file/content`, `write`, `tree`,
 * `delete`) rather than a dedicated sounds API so the macOS and web clients
 * read from the exact same on-disk format.
 */

import { client } from "@/generated/api/client.gen.js";
import { assertHasResponse } from "@/lib/api/errors.js";
import "@/lib/vellum-api/client.js";

import {
  defaultSoundsConfig,
  displayLabelForFilename,
  hasSupportedExtension,
  normaliseSoundsConfig,
  validateSoundFilename,
  type SoundsConfig,
} from "@/lib/sounds/types.js";

const SDK_BASE_OPTIONS =
  typeof window === "undefined"
    ? ({ baseUrl: "http://localhost" } as const)
    : ({} as const);

const CONFIG_PATH = "data/sounds/config.json";
const SOUNDS_DIR = "data/sounds";

export interface AvailableSound {
  /** Display label (filename with extension stripped). */
  label: string;
  /** Actual filename including extension, relative to `data/sounds/`. */
  filename: string;
}

interface WorkspaceTreeEntry {
  name?: string;
  path?: string;
  type?: string;
  size?: number;
  mimeType?: string;
  modifiedAt?: string;
}

interface WorkspaceTreeResponse {
  entries?: WorkspaceTreeEntry[];
}

/**
 * Fetch `data/sounds/config.json` from the assistant workspace.
 * Returns the default config when the file is missing or unreadable so
 * first-run still renders sensible state.
 */
export async function fetchSoundsConfig(
  assistantId: string,
): Promise<SoundsConfig> {
  try {
    const { data, error, response } = await client.get<Blob, unknown>({
      ...SDK_BASE_OPTIONS,
      url: "/v1/assistants/{assistant_id}/workspace/file/content/",
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

/**
 * Persist the sounds config to `data/sounds/config.json`.
 * Writes pretty-printed JSON that parses to the same object the macOS client reads.
 * Throws on network or server errors so callers can react (e.g. roll back
 * optimistic updates in React Query mutations).
 */
export async function saveSoundsConfig(
  assistantId: string,
  config: SoundsConfig,
): Promise<void> {
  const payload = JSON.stringify(config, null, 2);
  const base64 = typeof window === "undefined"
    ? Buffer.from(payload, "utf-8").toString("base64")
    : btoa(unescape(encodeURIComponent(payload)));

  const { error, response } = await client.post<unknown, unknown>({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/workspace/write/",
    path: { assistant_id: assistantId },
    body: { path: CONFIG_PATH, content: base64, encoding: "base64" },
    headers: { "Content-Type": "application/json" },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to save sounds config");
  if (!response.ok) {
    throw new Error(`Failed to save sounds config (status ${response.status})`);
  }
}

/**
 * List available audio files in `data/sounds/`, excluding `config.json`
 * and unsupported extensions. Entries are sorted by display label.
 */
export async function listAvailableSounds(
  assistantId: string,
): Promise<AvailableSound[]> {
  try {
    const { data, error, response } = await client.get<
      WorkspaceTreeResponse,
      unknown
    >({
      ...SDK_BASE_OPTIONS,
      url: "/v1/assistants/{assistant_id}/workspace/tree/",
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
      if (entry.type !== "file") {
        continue;
      }
      const name = entry.name;
      if (!name || name === "config.json") {
        continue;
      }
      if (!hasSupportedExtension(name)) {
        continue;
      }
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

/**
 * Fetch a sound file's raw bytes so it can be played via the Web Audio API
 * or HTMLAudioElement. Returns `null` when the file is missing.
 */
export async function fetchSoundFile(
  assistantId: string,
  filename: string,
): Promise<Blob | null> {
  if (!validateSoundFilename(filename)) {
    return null;
  }
  try {
    const { data, error, response } = await client.get<Blob, unknown>({
      ...SDK_BASE_OPTIONS,
      url: "/v1/assistants/{assistant_id}/workspace/file/content/",
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
