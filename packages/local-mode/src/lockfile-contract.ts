/**
 * The lockfile wire contract — the types and the parser that validates them —
 * kept in its own module so consumers can import the contract without pulling
 * in the host I/O graph (`node:fs`, the CLI resolver, the environments
 * package). The renderer relies on that separation: it imports these types
 * type-only and must not transitively reference Node built-ins.
 *
 * Validation is hand-written rather than schema-library-based on purpose: this
 * package is inlined from source by three different bundler hosts (the CLI, the
 * Electron main process, and the web dev server) and deliberately carries no
 * third-party runtime dependencies (enforced by `__tests__/package-boundary`).
 * The contract is small enough that a typed parser is clearer than a dependency.
 *
 * The lockfile is written by the Vellum CLI and read across the macOS↔CLI
 * boundary, which do not release in lockstep. The parser is therefore
 * permissive about unknown fields: it reads only the modeled fields below and
 * ignores everything else, so a newer writer's extra fields never fail an
 * older reader. Unknown fields are preserved on disk by the write path (see
 * `lockfile.ts`); the validated value returned to callers carries only the
 * modeled shape.
 *
 * `assistantId` is the only required field — it is the entry's identity (the
 * key every reader and the write path look entries up by) and the one field
 * the CLI always writes. Everything else is optional on disk: older entries
 * predate the `cloud` field, the runtime URL has historically been persisted
 * under a different key (`localUrl`), and resource ports are only present for
 * multi-instance local setups. The parser therefore salvages any entry that
 * has a string `assistantId` and copies the remaining modeled fields only when
 * they are present and well-typed, rather than discarding an otherwise-usable
 * assistant because an optional field is missing or malformed.
 */

export interface LocalAssistantResources {
  gatewayPort: number;
  daemonPort: number;
}

export interface LockfileAssistant {
  assistantId: string;
  name?: string;
  cloud?: string;
  runtimeUrl?: string;
  species?: string;
  hatchedAt?: string;
  /** Owning org for platform assistants; absent for local ones. */
  organizationId?: string;
  resources?: LocalAssistantResources;
}

export interface Lockfile {
  assistants: LockfileAssistant[];
  activeAssistant: string | null;
}

/**
 * Renderer-facing result of a lockfile write, returned across the host bridge.
 * Carries no HTTP-style `status` — the hosts map that away because the
 * renderer surfaces failures by message alone.
 */
export type LockfileWriteResult =
  | { ok: true; lockfile: Lockfile }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseResources(value: unknown): LocalAssistantResources | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.gatewayPort !== "number") return undefined;
  if (typeof value.daemonPort !== "number") return undefined;
  return { gatewayPort: value.gatewayPort, daemonPort: value.daemonPort };
}

/**
 * Validate a single assistant entry. Returns `null` only when the entry lacks a
 * string `assistantId` (its identity); any other entry is salvaged. Each
 * optional field is copied only when present and well-typed — a missing or
 * mistyped optional field is dropped from the result without discarding the
 * entry — and unknown fields are ignored.
 */
function parseAssistant(value: unknown): LockfileAssistant | null {
  if (!isRecord(value)) return null;
  if (typeof value.assistantId !== "string") return null;

  const assistant: LockfileAssistant = { assistantId: value.assistantId };
  if (typeof value.name === "string") assistant.name = value.name;
  if (typeof value.cloud === "string") assistant.cloud = value.cloud;
  if (typeof value.runtimeUrl === "string") assistant.runtimeUrl = value.runtimeUrl;
  if (typeof value.species === "string") assistant.species = value.species;
  if (typeof value.hatchedAt === "string") assistant.hatchedAt = value.hatchedAt;
  if (typeof value.organizationId === "string") assistant.organizationId = value.organizationId;
  const resources = parseResources(value.resources);
  if (resources) assistant.resources = resources;
  return assistant;
}

/**
 * Coerce parsed JSON into a validated `Lockfile`. Total and non-throwing:
 * individual assistant entries that fail validation are dropped (so one
 * malformed entry can't discard the whole file), a missing/non-array
 * `assistants` becomes `[]`, and a non-string `activeAssistant` becomes
 * `null`. Callers pass the result through unchanged; the only failure modes a
 * host surfaces are I/O and JSON-parse errors, handled by `getLockfileData`.
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
