/** Catalog discovery helpers for profile and test ids. */
import { readdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SAFE_ID = /^[a-z0-9][a-z0-9-]*$/;

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROFILES_DIR = join(HERE, "..", "..", "profiles");
const DEFAULT_TESTS_DIR = join(HERE, "..", "..", "tests");

export function getProfilesDir(): string {
  return process.env.EVALS_PROFILES_DIR ?? DEFAULT_PROFILES_DIR;
}

export function getTestsDir(): string {
  return process.env.EVALS_TESTS_DIR ?? DEFAULT_TESTS_DIR;
}

export function assertSafeId(kind: string, id: string): void {
  if (!SAFE_ID.test(id)) {
    throw new Error(
      `Invalid ${kind} id "${id}" — must match ${SAFE_ID.source}`,
    );
  }
}

export function resolveUnder(baseDir: string, ...segments: string[]): string {
  const base = resolve(baseDir);
  const target = resolve(base, ...segments);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`Refusing to resolve path outside of ${base}: ${target}`);
  }
  return target;
}

async function listDirectoryIds(rootDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw new Error(
      `Failed to read eval catalog directory at ${rootDir}: ${(err as Error).message}`,
    );
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith("."))
    .sort();
}

export async function listProfileIds(): Promise<string[]> {
  const ids = await listDirectoryIds(getProfilesDir());
  ids.forEach((id) => assertSafeId("profile", id));
  return ids;
}

export async function listTestIds(): Promise<string[]> {
  const ids = await listDirectoryIds(getTestsDir());
  ids.forEach((id) => assertSafeId("test", id));
  return ids;
}
