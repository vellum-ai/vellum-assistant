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
import { z } from "zod";

import { assertSafeId, getProfilesDir, resolveUnder } from "./catalog";

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
  /**
   * Feature-flag overrides to apply to the hatched assistant before any
   * setup commands run. Keys are flag ids from
   * `meta/feature-flags/feature-flag-registry.json` (kebab-case); values
   * are the boolean override to push to the gateway.
   *
   * This is the **declarative** path for flag setup. Use it whenever a
   * profile's setup commands rely on a gated surface — for example,
   * `vellum-simple-memory` runs `assistant plugins install simple-memory`,
   * which only works when the `external-plugins` flag is enabled. Setting
   * the flag inside `setup` would be a chicken-and-egg problem because
   * setup commands execute inside the assistant container via
   * `vellum exec`, whereas flag overrides live on the host gateway.
   *
   * Translates to `vellum flags set <key> <bool> --assistant <id>` calls
   * (species-specific adapters decide whether to apply them).
   *
   * Example:
   *   "featureFlags": { "external-plugins": true }
   */
  featureFlags: z.record(z.string(), z.boolean()).optional(),
});

export type ProfileManifest = z.infer<typeof ProfileManifestSchema>;

export interface Profile {
  /** Directory name under `profiles/`. */
  id: string;
  manifest: ProfileManifest;
  /** Absolute path to `profiles/<id>/workspace/` — may not exist on disk. */
  workspaceDir: string;
}

export async function loadProfile(id: string): Promise<Profile> {
  assertSafeId("profile", id);
  const base = getProfilesDir();
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
