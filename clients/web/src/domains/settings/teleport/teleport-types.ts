/**
 * Pure types and decision logic for the teleport feature — the web/Electron
 * port of the macOS `TeleportSection.swift`.
 *
 * Teleport moves an assistant between hosting environments (local, Docker, or
 * the Vellum cloud platform) *without* retiring the source until the user
 * confirms the new one works. Everything in this file is side-effect-free so it
 * can be unit-tested without the gateway/platform transport.
 */

/** Where an assistant can be teleported to. */
export type TeleportDestination = "docker" | "platform" | "local";

/** Coarse hosting classification of an assistant, derived from its lockfile `cloud`. */
export type AssistantHosting = "local" | "docker" | "managed" | "other";

/** UI/state-machine phase, mirroring the Swift `TeleportPhase` enum. */
export type TeleportPhase =
  | { kind: "idle" }
  | { kind: "transferring"; step: string; progress: number | null }
  | { kind: "verifying" }
  | { kind: "failed"; error: string };

/** Stable error codes for teleport failures, mirroring Swift `TeleportError`. */
export type TeleportErrorCode =
  | "not_signed_in"
  | "export_failed"
  | "export_timed_out"
  | "export_job_failed"
  | "import_failed"
  | "managed_entry_not_found"
  | "local_assistant_not_found"
  | "docker_assistant_not_found"
  | "no_organizations"
  | "multiple_organizations"
  | "existing_platform_assistant"
  | "version_mismatch"
  | "unknown";

/** A teleport error carrying a stable code plus a human-readable message. */
export class TeleportError extends Error {
  readonly code: TeleportErrorCode;

  constructor(code: TeleportErrorCode, message: string) {
    super(message);
    this.name = "TeleportError";
    this.code = code;
  }
}

/** The lockfile `cloud` value reported for each hosting kind. */
const LOCAL_CLOUD = "local";
const DOCKER_CLOUD = "docker";
const MANAGED_CLOUD = "vellum";

/** Classify an assistant's hosting from its lockfile `cloud` string. */
export function classifyHosting(cloud: string | undefined): AssistantHosting {
  switch ((cloud ?? "").toLowerCase()) {
    case LOCAL_CLOUD:
      return "local";
    case DOCKER_CLOUD:
      return "docker";
    case MANAGED_CLOUD:
      return "managed";
    default:
      return "other";
  }
}

/**
 * The single destination the picker offers for an assistant:
 *   - managed (cloud)            → move to local
 *   - local                      → move to cloud (platform)
 *   - anything else              → no teleport offered
 *
 * Docker is intentionally excluded: the web client only reaches local-kind
 * assistants over the local gateway proxy (`getLocalGatewayUrl` resolves
 * `cloud === "local"` only), so there is no transport to export a Docker
 * assistant. Offering it would fail before export.
 */
export function resolveDestination(
  cloud: string | undefined,
): TeleportDestination | null {
  const hosting = classifyHosting(cloud);
  if (hosting === "managed") return "local";
  if (hosting === "local") return "platform";
  return null;
}

/** Human-facing label for a destination, mirroring Swift `displayLabel`. */
export function destinationLabel(destination: TeleportDestination): string {
  switch (destination) {
    case "docker":
      return "Move to Docker";
    case "platform":
      return "Move to Cloud (Platform)";
    case "local":
      return "Move to Local";
  }
}

/** One-line description for a destination, mirroring Swift `description`. */
export function destinationDescription(
  destination: TeleportDestination,
): string {
  switch (destination) {
    case "docker":
      return "Run your assistant in a Docker container on this Mac.";
    case "platform":
      return "Run your assistant in the cloud, managed by the Vellum platform.";
    case "local":
      return "Run your assistant locally on this Mac.";
  }
}

/**
 * Parse a platform `signed-url` (download) 422 body into a version-mismatch
 * error message, mirroring the Swift `versionMismatch` decoding. Returns
 * `null` when the body isn't a recognizable version-mismatch payload.
 */
export function parseVersionMismatch(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const json = body as Record<string, unknown>;
  if (json.reason !== "version_mismatch") return null;

  const compat = json.bundle_compat;
  const targetVersion = json.target_runtime_version;
  if (!compat || typeof compat !== "object" || typeof targetVersion !== "string") {
    return null;
  }
  const compatObj = compat as Record<string, unknown>;
  const minVersion = compatObj.min_runtime_version;
  if (typeof minVersion !== "string") return null;
  const maxVersion =
    typeof compatObj.max_runtime_version === "string"
      ? compatObj.max_runtime_version
      : null;

  const range = maxVersion ? `${minVersion}–${maxVersion}` : `${minVersion}+`;
  return `Cannot import: bundle requires runtime ${range}, but this local runtime is ${targetVersion}. Update your local runtime before importing.`;
}
