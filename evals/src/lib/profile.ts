/**
 * Profile — declarative unit of (species × plugins × initial state) variation.
 *
 * Schema is intentionally lean for v0.1; it locks in only what the plan v2
 * commits to. Future fields (plugin config blobs, integration mocks, version
 * pinning per species) can extend the `plugins` value shape without breaking
 * existing profile JSON because each value is itself a passthrough record.
 */
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SPECIES = [
  "vellum",
  "openclaw",
  "claude-code",
  "codex",
  "hermes",
] as const;

export const ProfileSchema = z.object({
  /** Unique profile identifier. Must match the filename: `profiles/<id>.json`. */
  id: z.string().min(1),
  /** Agent species — the adapter selector. */
  species: z.enum(SPECIES),
  /**
   * Optional version pin. Only meaningful for species whose build versioning
   * is external (everything except Vellum). Vellum profiles ignore this field.
   */
  version: z.string().optional(),
  /**
   * Plugin map: { pluginName: { config-shape-tbd } }. Empty object means bare.
   * The value is a passthrough record so per-plugin config can extend later
   * without breaking the schema.
   */
  plugins: z.record(z.string(), z.record(z.string(), z.unknown())),
  /**
   * Files dropped into the agent's workspace before the test starts.
   * Keys are relative filenames; values are file contents (UTF-8).
   * Empty object means no setup files.
   */
  initial_state: z.record(z.string(), z.string()),
});

export type Profile = z.infer<typeof ProfileSchema>;

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROFILES_DIR = join(HERE, "..", "..", "profiles");

function profilesDir(): string {
  return process.env.EVALS_PROFILES_DIR ?? DEFAULT_PROFILES_DIR;
}

export async function loadProfile(id: string): Promise<Profile> {
  const path = join(profilesDir(), `${id}.json`);

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`Profile "${id}" not found at ${path}`);
    }
    throw new Error(
      `Failed to read profile "${id}" at ${path}: ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Profile "${id}" at ${path} is not valid JSON: ${(err as Error).message}`,
    );
  }

  const result = ProfileSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Profile "${id}" at ${path} failed schema validation:\n${issues}`,
    );
  }

  if (result.data.id !== id) {
    throw new Error(
      `Profile id mismatch: file at ${path} declares id "${result.data.id}" but was loaded as "${id}"`,
    );
  }

  return result.data;
}
