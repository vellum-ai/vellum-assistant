/**
 * Character component catalog — fetched from the platform's public API.
 *
 * The canonical data lives in the platform repo as a static JSON file
 * served at GET /v1/avatar/character-components/. This module fetches it
 * once and caches in memory for the lifetime of the process.
 *
 * Fallback: if the platform is unreachable, fetches the raw JSON from
 * the vellum-assistant-platform repo on GitHub.
 */

import { getPlatformBaseUrl } from "../config/env.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("character-components");

export interface BodyShapeDefinition {
  id: string;
  viewBox: { width: number; height: number };
  faceCenter: { x: number; y: number };
  svgPath: string;
}

export interface EyePathDefinition {
  svgPath: string;
  color: string;
}

export interface EyeStyleDefinition {
  id: string;
  sourceViewBox: { width: number; height: number };
  eyeCenter: { x: number; y: number };
  paths: EyePathDefinition[];
}

export interface ColorDefinition {
  id: string;
  hex: string;
}

export interface FaceCenterOverride {
  bodyShape: string;
  eyeStyle: string;
  faceCenter: { x: number; y: number };
}

export interface CharacterComponents {
  bodyShapes: BodyShapeDefinition[];
  eyeStyles: EyeStyleDefinition[];
  colors: ColorDefinition[];
  faceCenterOverrides: FaceCenterOverride[];
}

const GITHUB_RAW_URL =
  "https://raw.githubusercontent.com/vellum-ai/vellum-assistant-platform/main/django/app/avatar/character-components.json";

let _cached: CharacterComponents | null = null;

async function fetchFromPlatform(): Promise<CharacterComponents> {
  const baseUrl = getPlatformBaseUrl();
  const resp = await fetch(`${baseUrl}/v1/avatar/character-components/`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!resp.ok) {
    throw new Error(`Platform returned ${resp.status}`);
  }
  return resp.json() as Promise<CharacterComponents>;
}

async function fetchFromGitHub(): Promise<CharacterComponents> {
  const resp = await fetch(GITHUB_RAW_URL, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    throw new Error(`GitHub returned ${resp.status}`);
  }
  return resp.json() as Promise<CharacterComponents>;
}

/**
 * Get the character component catalog.
 *
 * Fetches from the platform API on first call, falls back to GitHub raw
 * content, and caches in memory for the process lifetime.
 */
export async function getCharacterComponents(): Promise<CharacterComponents> {
  if (_cached) return _cached;

  try {
    _cached = await fetchFromPlatform();
    log.info("Loaded character components from platform");
    return _cached;
  } catch (err) {
    log.warn(
      { error: String(err) },
      "Platform fetch failed, falling back to GitHub",
    );
  }

  _cached = await fetchFromGitHub();
  log.info("Loaded character components from GitHub");
  return _cached;
}
