import { currentLocale } from "@/i18n";
import { ApiError } from "@/utils/api-errors";

/**
 * The daemon's code for a delete refused because provider connections still
 * resolve their auth through the credential.
 */
const CREDENTIAL_IN_USE = "CREDENTIAL_IN_USE";

/**
 * Names of the provider connections that blocked a credential delete, or
 * `null` when the failure was anything else.
 *
 * The daemon refuses such a delete with `CREDENTIAL_IN_USE` and lists the
 * dependent connections in `error.details.connections`, so the confirmation
 * prompt can name exactly what a forced delete would take offline.
 */
export function credentialInUseConnections(error: unknown): string[] | null {
  if (!(error instanceof ApiError) || error.code !== CREDENTIAL_IN_USE) {
    return null;
  }
  const details = error.details;
  if (!details || typeof details !== "object" || !("connections" in details)) {
    return null;
  }
  const { connections } = details;
  if (
    !Array.isArray(connections) ||
    !connections.every((name) => typeof name === "string")
  ) {
    return null;
  }
  return connections;
}

/**
 * Connection names joined for the active locale, so the warning reads as a
 * sentence rather than a comma-separated dump.
 */
export function formatConnectionNames(connections: string[]): string {
  return new Intl.ListFormat(currentLocale(), {
    style: "long",
    type: "conjunction",
  }).format(connections);
}
