import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getDataDir } from "../util/platform.js";

const HATCHED_SIDECAR_FILENAME = "hatched.json";

export function getHatchedSidecarPath(): string {
  return join(getDataDir(), HATCHED_SIDECAR_FILENAME);
}

function normalizeHatchedAt(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  const parsedTime = Date.parse(value);
  if (isNaN(parsedTime) || parsedTime <= 0) return undefined;

  return new Date(parsedTime).toISOString();
}

export function readHatchedAtSidecar(): string | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(getHatchedSidecarPath(), "utf-8"),
    ) as { hatchedAt?: unknown };
    return normalizeHatchedAt(parsed.hatchedAt);
  } catch {
    return undefined;
  }
}

export function writeHatchedAtSidecar(hatchedAt: string): void {
  const normalized = normalizeHatchedAt(hatchedAt);
  if (!normalized) return;

  try {
    mkdirSync(getDataDir(), { recursive: true });
    writeFileSync(
      getHatchedSidecarPath(),
      JSON.stringify({ hatchedAt: normalized }, null, 2),
      "utf-8",
    );
  } catch {
    // Best-effort stability; callers still return a valid timestamp.
  }
}

export function selectHatchedAtFromStats(stats: {
  birthtime: Date;
  mtime: Date;
}): Date | undefined {
  const candidates = [stats.birthtime, stats.mtime];
  return candidates.find((candidate) => candidate.getTime() > 0);
}

function readIdentityFileHatchedAt(identityPath: string): string | undefined {
  try {
    return selectHatchedAtFromStats(statSync(identityPath))?.toISOString();
  } catch {
    return undefined;
  }
}

export function resolveHatchedAtReadOnly(
  identityPath: string,
  now: Date = new Date(),
): string {
  return (
    readHatchedAtSidecar() ??
    readIdentityFileHatchedAt(identityPath) ??
    now.toISOString()
  );
}

export function resolveAndPersistHatchedAt(
  identityPath: string,
  now: Date = new Date(),
): string {
  const sidecarHatchedAt = readHatchedAtSidecar();
  if (sidecarHatchedAt) return sidecarHatchedAt;

  const hatchedAt =
    readIdentityFileHatchedAt(identityPath) ?? now.toISOString();
  writeHatchedAtSidecar(hatchedAt);
  return hatchedAt;
}
