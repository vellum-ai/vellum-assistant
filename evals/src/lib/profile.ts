/**
 * Profile — declarative unit of (species × setup × initial workspace) variation.
 *
 * A profile lives at `profiles/<id>/` with:
 *   - `manifest.json` — species + optional version + optional setup commands
 *   - `workspace/`    — optional directory of files dropped into the agent's
 *                       workspace before the run starts
 *
 * The profile id is the directory name; the manifest does not declare it.
 */
import { readFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

const SPECIES = [
  "vellum",
  "openclaw",
  "claude-code",
  "codex",
  "hermes",
] as const;

export const ProfileManifestSchema = z.object({
  /** Agent species — the adapter selector. */
  species: z.enum(SPECIES),
  /**
   * Optional version pin. Useful for comparing different versions of the
   * same species side-by-side (e.g. two Vellum builds, two Hermes releases).
   */
  version: z.string().optional(),
  /**
   * Commands to run after the agent is hatched and before the test starts.
   * Use this to install plugins, drop config, or otherwise shape the agent
   * environment. Each entry is a single shell command.
   *
   * Example:
   *   "setup": ["vellum exec -- assistant plugins install simple-memory"]
   */
  setup: z.union([z.string(), z.array(z.string())]).optional(),
});

export type ProfileManifest = z.infer<typeof ProfileManifestSchema>;

export interface Profile {
  /** Directory name under `profiles/`. */
  id: string;
  manifest: ProfileManifest;
  /** Absolute path to `profiles/<id>/workspace/` — may not exist on disk. */
  workspaceDir: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROFILES_DIR = join(HERE, "..", "..", "profiles");

function profilesDir(): string {
  return process.env.EVALS_PROFILES_DIR ?? DEFAULT_PROFILES_DIR;
}

// Conservative id pattern — disallows leading hyphens, dots, slashes, anything
// other than lowercase alphanumerics + hyphens. Guards against path traversal
// and keeps profile ids URL-safe.
const SAFE_ID = /^[a-z0-9][a-z0-9-]*$/;

function assertSafeId(kind: string, id: string): void {
  if (!SAFE_ID.test(id)) {
    throw new Error(
      `Invalid ${kind} id "${id}" — must match ${SAFE_ID.source}`,
    );
  }
}

function resolveUnder(baseDir: string, ...segments: string[]): string {
  const base = resolve(baseDir);
  const target = resolve(base, ...segments);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`Refusing to resolve path outside of ${base}: ${target}`);
  }
  return target;
}

export async function loadProfile(id: string): Promise<Profile> {
  assertSafeId("profile", id);
  const base = profilesDir();
  const manifestPath = resolveUnder(base, id, "manifest.json");
  const workspaceDir = resolveUnder(base, id, "workspace");

  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`Profile "${id}" not found — expected ${manifestPath}`);
    }
    throw new Error(
      `Failed to read profile "${id}" manifest at ${manifestPath}: ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Profile "${id}" manifest at ${manifestPath} is not valid JSON: ${(err as Error).message}`,
    );
  }

  const result = ProfileManifestSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Profile "${id}" manifest at ${manifestPath} failed schema validation:\n${issues}`,
    );
  }

  return {
    id,
    manifest: result.data,
    workspaceDir,
  };
}
