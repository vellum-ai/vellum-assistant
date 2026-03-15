/**
 * CES credential handle formats and parser helpers.
 *
 * A "handle" is an opaque string that the assistant passes to CES to identify
 * which credential context should be used for a given execution. Handles never
 * contain secret material — they are references that CES resolves internally.
 *
 * v1 handle formats:
 *
 * 1. **Local static** — references a credential stored in the local secure-key
 *    backend. Format: `local_static:<service>/<field>` (matches the
 *    `credential/{service}/{field}` key pattern from credential-storage).
 *
 * 2. **Local OAuth** — references a locally persisted OAuth connection.
 *    Format: `local_oauth:<providerKey>/<connectionId>` where providerKey
 *    uses the existing `integration:*` keys (e.g. `integration:google`).
 *
 * 3. **Managed OAuth** — references an OAuth connection managed by the
 *    platform. Format: `platform_oauth:<connectionId>` where connectionId
 *    is the platform-assigned connection identifier.
 */

import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// Handle type discriminator
// ---------------------------------------------------------------------------

export const HandleType = {
  LocalStatic: "local_static",
  LocalOAuth: "local_oauth",
  PlatformOAuth: "platform_oauth",
} as const;

export type HandleType = (typeof HandleType)[keyof typeof HandleType];

// ---------------------------------------------------------------------------
// Parsed handle shapes
// ---------------------------------------------------------------------------

export interface LocalStaticHandle {
  type: typeof HandleType.LocalStatic;
  /** Service name (e.g. "github", "fal"). */
  service: string;
  /** Field name within the service (e.g. "api_key", "password"). */
  field: string;
  /** The raw handle string. */
  raw: string;
}

export interface LocalOAuthHandle {
  type: typeof HandleType.LocalOAuth;
  /** Provider key (e.g. "integration:google", "integration:slack"). */
  providerKey: string;
  /** Connection identifier. */
  connectionId: string;
  /** The raw handle string. */
  raw: string;
}

export interface PlatformOAuthHandle {
  type: typeof HandleType.PlatformOAuth;
  /** Platform-assigned connection identifier. */
  connectionId: string;
  /** The raw handle string. */
  raw: string;
}

export type ParsedHandle =
  | LocalStaticHandle
  | LocalOAuthHandle
  | PlatformOAuthHandle;

// ---------------------------------------------------------------------------
// Handle construction helpers
// ---------------------------------------------------------------------------

/**
 * Build a local static credential handle from service and field.
 *
 * Accepts the same service/field values used in `credentialKey()` from
 * `@vellumai/credential-storage`.
 */
export function localStaticHandle(service: string, field: string): string {
  return `${HandleType.LocalStatic}:${service}/${field}`;
}

/**
 * Build a local OAuth credential handle from a provider key and connection ID.
 */
export function localOAuthHandle(
  providerKey: string,
  connectionId: string,
): string {
  return `${HandleType.LocalOAuth}:${providerKey}/${connectionId}`;
}

/**
 * Build a managed (platform) OAuth credential handle from a connection ID.
 */
export function platformOAuthHandle(connectionId: string): string {
  return `${HandleType.PlatformOAuth}:${connectionId}`;
}

// ---------------------------------------------------------------------------
// Handle parsing
// ---------------------------------------------------------------------------

export type ParseHandleResult =
  | { ok: true; handle: ParsedHandle }
  | { ok: false; error: string };

/**
 * Parse a raw handle string into a structured `ParsedHandle`.
 *
 * Returns a discriminated result so callers can inspect parse errors
 * without catching exceptions.
 */
export function parseHandle(raw: string): ParseHandleResult {
  const colonIdx = raw.indexOf(":");
  if (colonIdx === -1) {
    return { ok: false, error: `Invalid handle format: missing type prefix in "${raw}"` };
  }

  const prefix = raw.slice(0, colonIdx);
  const rest = raw.slice(colonIdx + 1);

  switch (prefix) {
    case HandleType.LocalStatic: {
      const slashIdx = rest.indexOf("/");
      if (slashIdx === -1 || slashIdx === 0 || slashIdx === rest.length - 1) {
        return {
          ok: false,
          error: `Invalid local_static handle: expected "local_static:<service>/<field>", got "${raw}"`,
        };
      }
      return {
        ok: true,
        handle: {
          type: HandleType.LocalStatic,
          service: rest.slice(0, slashIdx),
          field: rest.slice(slashIdx + 1),
          raw,
        },
      };
    }

    case HandleType.LocalOAuth: {
      // providerKey may itself contain a colon (e.g. "integration:google"),
      // so we split on the *last* "/" to separate providerKey from connectionId.
      const lastSlashIdx = rest.lastIndexOf("/");
      if (
        lastSlashIdx === -1 ||
        lastSlashIdx === 0 ||
        lastSlashIdx === rest.length - 1
      ) {
        return {
          ok: false,
          error: `Invalid local_oauth handle: expected "local_oauth:<providerKey>/<connectionId>", got "${raw}"`,
        };
      }
      return {
        ok: true,
        handle: {
          type: HandleType.LocalOAuth,
          providerKey: rest.slice(0, lastSlashIdx),
          connectionId: rest.slice(lastSlashIdx + 1),
          raw,
        },
      };
    }

    case HandleType.PlatformOAuth: {
      if (!rest || rest.length === 0) {
        return {
          ok: false,
          error: `Invalid platform_oauth handle: missing connectionId in "${raw}"`,
        };
      }
      return {
        ok: true,
        handle: {
          type: HandleType.PlatformOAuth,
          connectionId: rest,
          raw,
        },
      };
    }

    default:
      return {
        ok: false,
        error: `Unknown handle type prefix "${prefix}" in "${raw}"`,
      };
  }
}

// ---------------------------------------------------------------------------
// Zod schema for wire validation
// ---------------------------------------------------------------------------

/**
 * Zod schema that validates a string as a well-formed CES credential handle.
 * Useful in RPC schemas where the handle travels on the wire.
 */
export const CredentialHandleSchema = z
  .string()
  .check(
    z.refine((val: string) => {
      const result = parseHandle(val);
      return result.ok;
    }, "Must be a valid CES credential handle (local_static:*, local_oauth:*, or platform_oauth:*)"),
  );
