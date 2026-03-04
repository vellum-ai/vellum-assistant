import {
  getMemoryCheckpoint,
  setMemoryCheckpoint,
} from "../memory/checkpoints.js";

const ACTIVE_RELEASES_KEY = "updates:active_releases";
const COMPLETED_RELEASES_KEY = "updates:completed_releases";

function parseReleaseArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

function dedupAndSort(releases: string[]): string[] {
  return [...new Set(releases)].sort();
}

export function getActiveReleases(): string[] {
  return parseReleaseArray(getMemoryCheckpoint(ACTIVE_RELEASES_KEY));
}

export function setActiveReleases(releases: string[]): void {
  setMemoryCheckpoint(
    ACTIVE_RELEASES_KEY,
    JSON.stringify(dedupAndSort(releases)),
  );
}

export function getCompletedReleases(): string[] {
  return parseReleaseArray(getMemoryCheckpoint(COMPLETED_RELEASES_KEY));
}

export function setCompletedReleases(releases: string[]): void {
  setMemoryCheckpoint(
    COMPLETED_RELEASES_KEY,
    JSON.stringify(dedupAndSort(releases)),
  );
}

export function isReleaseCompleted(version: string): boolean {
  return getCompletedReleases().includes(version);
}

export function markReleasesCompleted(versions: string[]): void {
  const existing = getCompletedReleases();
  setCompletedReleases([...existing, ...versions]);
}

export function addActiveRelease(version: string): void {
  const existing = getActiveReleases();
  setActiveReleases([...existing, version]);
}
