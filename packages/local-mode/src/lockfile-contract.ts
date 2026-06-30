/**
 * The lockfile wire contract — one Zod schema that is the single source of truth
 * for an assistant entry's shape, its validation, the `cloud` taxonomy, the
 * normalization, and the redaction policy.
 *
 * Kept in its own module, exported from the package as `./contract`, so
 * consumers import the contract without pulling in the host I/O graph
 * (`node:fs`, the CLI resolver). The CLI, the host I/O layer, the Electron and
 * dev-server bridges, and the renderer all depend on this one definition. It
 * references no node built-ins — the renderer bundles it directly — and `zod`
 * is its only third-party import.
 *
 * The lockfile is written by the Vellum CLI and read across the macOS↔CLI
 * boundary, which do not release in lockstep, so the parser is permissive: it
 * validates the modeled fields, salvages an entry on the strength of its
 * `assistantId` alone (dropping individual malformed optional fields rather
 * than the whole entry), and ignores unknown fields so a newer writer never
 * breaks an older reader. Unknown fields are preserved on disk by the write
 * path (see `lockfile.ts`); the validated value carries only the modeled,
 * renderer-safe shape.
 */
import { z } from "zod";

/**
 * Known deployment topologies. `cloud` is stored as a free string on disk for
 * forward-compatibility — an older reader must tolerate a newer writer's value
 * — but the known set is enumerated here so callers switch on it exhaustively
 * instead of matching string literals scattered across the codebase:
 *  - `local` — on-machine daemon
 *  - `docker` — local container
 *  - `apple-container` — macOS-app-managed container
 *  - `vellum` — platform-managed (uses the X-Session-Token auth path)
 *  - `gcp` / `aws` / `custom` — remote, SSH-managed
 *  - `paired` — a remote assistant paired from another machine
 */
export const KNOWN_CLOUDS = [
  "local",
  "docker",
  "apple-container",
  "vellum",
  "gcp",
  "aws",
  "custom",
  "paired",
] as const;
export type KnownCloud = (typeof KNOWN_CLOUDS)[number];
export type Cloud = KnownCloud | (string & {});

/**
 * Keys that must never cross the host→renderer boundary. Stripped from raw
 * lockfile JSON before it leaves a host (see `stripSensitiveFields`) and absent
 * from the renderer-facing schema below; the CLI's extended type is the only
 * place they are modeled.
 */
export const SENSITIVE_KEYS = [
  "signingKey",
  "bearerToken",
  "guardianBootstrapSecret",
] as const;

/**
 * Resolve an entry's deployment topology from its raw on-disk fields. Prefers
 * an explicit `cloud`, then the legacy markers that predate the field
 * (`project` ⇒ gcp, `sshUser` ⇒ custom), and defaults to "local". This is the
 * one definition every reader shares, so a cloudless entry is classified
 * identically by the CLI, the host I/O layer, and the renderer.
 */
export function resolveCloud(raw: {
  cloud?: unknown;
  project?: unknown;
  sshUser?: unknown;
}): Cloud {
  if (typeof raw.cloud === "string" && raw.cloud) return raw.cloud;
  if (typeof raw.project === "string" && raw.project) return "gcp";
  if (typeof raw.sshUser === "string" && raw.sshUser) return "custom";
  return "local";
}

/**
 * Per-instance resources for a local assistant: the renderer-facing subset of
 * ports, the instance directory, and the local runtime install metadata.
 * Richer host-only fields (other ports, the signing key) live on the CLI's
 * type and are stripped from this shape.
 */
export const LocalAssistantResourcesSchema = z.object({
  instanceDir: z.string().optional(),
  gatewayPort: z.number(),
  daemonPort: z.number(),
  runtimeVersion: z.string().optional(),
  runtimeInstallDir: z.string().optional(),
});
export type LocalAssistantResources = z.infer<
  typeof LocalAssistantResourcesSchema
>;

/**
 * The renderer-safe shape of one assistant entry. `assistantId` is the only
 * required field — the identity every reader looks entries up by — and every
 * other field is salvaged by {@link parseLockfile}. The CLI extends this with
 * its host-only and sensitive fields; this base carries only what is safe to
 * surface in the renderer.
 */
export const LockfileAssistantSchema = z.object({
  assistantId: z.string(),
  name: z.string().optional(),
  cloud: z.string().optional(),
  runtimeUrl: z.string().optional(),
  species: z.string().optional(),
  hatchedAt: z.string().optional(),
  /** Owning org for platform assistants; absent for local ones. */
  organizationId: z.string().optional(),
  /** Platform self-hosted registration metadata for local assistants. */
  platformAssistantId: z.string().optional(),
  platformBaseUrl: z.string().optional(),
  platformOrganizationId: z.string().optional(),
  resources: LocalAssistantResourcesSchema.optional(),
});

/**
 * A validated, normalized assistant entry. Identical to the schema's inferred
 * shape except `cloud` is always present — {@link parseLockfile} resolves it for
 * every entry (defaulting to "local"), so readers never special-case its
 * absence.
 */
export type LockfileAssistant = Omit<
  z.infer<typeof LockfileAssistantSchema>,
  "cloud"
> & { cloud: Cloud };

export interface Lockfile {
  assistants: LockfileAssistant[];
  activeAssistant: string | null;
}

/**
 * Renderer-facing result of a lockfile write, returned across the host bridge.
 * Carries no HTTP-style status — hosts map that away because the renderer
 * surfaces failures by message alone.
 */
export type LockfileWriteResult =
  { ok: true; lockfile: Lockfile } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate and normalize a single entry. Returns null only when `assistantId`
 * is missing or not a string; any other entry is salvaged — each modeled field
 * is copied only when present and well-typed (a malformed optional field is
 * dropped without discarding the entry), unknown fields are ignored, and
 * `cloud` is resolved from the raw markers so a cloudless remote entry is never
 * mistaken for a local one and a markerless entry defaults to "local".
 */
function parseAssistant(raw: unknown): LockfileAssistant | null {
  if (!isRecord(raw) || typeof raw.assistantId !== "string") return null;
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(LockfileAssistantSchema.shape)) {
    const result = (field as z.ZodType).safeParse(raw[key]);
    if (result.success && result.data !== undefined) out[key] = result.data;
  }
  out.cloud = resolveCloud(raw);
  return out as LockfileAssistant;
}

/**
 * Coerce parsed JSON into a validated {@link Lockfile}. Total and non-throwing:
 * entries that fail validation are dropped (one malformed entry can't discard
 * the file), a missing or non-array `assistants` becomes `[]`, and a non-string
 * `activeAssistant` becomes null.
 */
export function parseLockfile(raw: unknown): Lockfile {
  const root = isRecord(raw) ? raw : {};
  const rawAssistants = Array.isArray(root.assistants) ? root.assistants : [];
  const assistants: LockfileAssistant[] = [];
  for (const entry of rawAssistants) {
    const parsed = parseAssistant(entry);
    if (parsed) assistants.push(parsed);
  }
  const activeAssistant =
    typeof root.activeAssistant === "string" ? root.activeAssistant : null;
  return { assistants, activeAssistant };
}
