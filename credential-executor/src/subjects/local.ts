/**
 * CES local subject resolution.
 *
 * Resolves CES credential handles to their underlying storage subjects
 * using the shared `@vellumai/credential-storage` primitives. This module
 * is the CES-side counterpart to the assistant's credential resolver, but
 * operates independently — it never imports from the assistant daemon.
 *
 * Subject resolution is the first phase of credential materialisation:
 * 1. Parse the handle (via `@vellumai/ces-contracts`)
 * 2. Look up the metadata/connection record in local storage
 * 3. Return a resolved subject that the materialiser can consume
 *
 * Both `local_static` and `local_oauth` handle types are supported.
 * Unknown or disconnected handles fail before any outbound work starts.
 */

import {
  credentialKey,
  type OAuthConnectionRecord,
  type StaticCredentialRecord,
  StaticCredentialMetadataStore,
} from "@vellumai/credential-storage";
import {
  HandleType,
  parseHandle,
  type LocalOAuthHandle,
  type LocalStaticHandle,
} from "@vellumai/ces-contracts";

// ---------------------------------------------------------------------------
// Resolved subject types
// ---------------------------------------------------------------------------

/**
 * A resolved local static credential subject. Contains the metadata record
 * and the secure-key storage key needed to materialise the secret value.
 */
export interface ResolvedStaticSubject {
  type: typeof HandleType.LocalStatic;
  /** The parsed handle. */
  handle: LocalStaticHandle;
  /** Non-secret metadata record from the credential store. */
  metadata: StaticCredentialRecord;
  /** Secure-key path where the secret value is stored. */
  storageKey: string;
}

/**
 * A resolved local OAuth credential subject. Contains the connection record
 * and the connection ID needed to materialise the access token.
 */
export interface ResolvedOAuthSubject {
  type: typeof HandleType.LocalOAuth;
  /** The parsed handle. */
  handle: LocalOAuthHandle;
  /** OAuth connection record from local persistence. */
  connection: OAuthConnectionRecord;
}

export type ResolvedLocalSubject =
  | ResolvedStaticSubject
  | ResolvedOAuthSubject;

// ---------------------------------------------------------------------------
// Resolution result
// ---------------------------------------------------------------------------

export type SubjectResolutionResult =
  | { ok: true; subject: ResolvedLocalSubject }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// OAuth connection lookup abstraction
// ---------------------------------------------------------------------------

/**
 * Abstraction for looking up local OAuth connection records.
 *
 * CES does not import the assistant's SQLite-backed oauth-store. Instead,
 * callers provide a lightweight lookup interface that can be backed by
 * any persistence mechanism (JSON file, SQLite, in-memory map).
 */
export interface OAuthConnectionLookup {
  /** Look up a connection by its ID. Returns undefined if not found. */
  getById(connectionId: string): OAuthConnectionRecord | undefined;
}

// ---------------------------------------------------------------------------
// Local subject resolver
// ---------------------------------------------------------------------------

export interface LocalSubjectResolverDeps {
  /** Metadata store for local static credentials. */
  metadataStore: StaticCredentialMetadataStore;
  /** Lookup for local OAuth connections. */
  oauthConnections: OAuthConnectionLookup;
}

/**
 * Resolve a CES credential handle to a local subject.
 *
 * Supports `local_static` and `local_oauth` handle types. Returns a
 * discriminated result so callers can inspect errors without catching
 * exceptions.
 *
 * Resolution is fail-closed: unknown handle types, missing metadata,
 * and disconnected OAuth connections all return errors before any
 * outbound work starts.
 */
export function resolveLocalSubject(
  rawHandle: string,
  deps: LocalSubjectResolverDeps,
): SubjectResolutionResult {
  const parseResult = parseHandle(rawHandle);
  if (!parseResult.ok) {
    return { ok: false, error: parseResult.error };
  }

  const parsed = parseResult.handle;

  switch (parsed.type) {
    case HandleType.LocalStatic: {
      const metadata = deps.metadataStore.getByServiceField(
        parsed.service,
        parsed.field,
      );
      if (!metadata) {
        return {
          ok: false,
          error: `No local static credential found for service="${parsed.service}", field="${parsed.field}"`,
        };
      }
      const storageKey = credentialKey(parsed.service, parsed.field);
      return {
        ok: true,
        subject: {
          type: HandleType.LocalStatic,
          handle: parsed,
          metadata,
          storageKey,
        },
      };
    }

    case HandleType.LocalOAuth: {
      const connection = deps.oauthConnections.getById(parsed.connectionId);
      if (!connection) {
        return {
          ok: false,
          error: `No local OAuth connection found for connectionId="${parsed.connectionId}"`,
        };
      }
      // Verify the provider key matches the connection's provider
      if (connection.providerKey !== parsed.providerKey) {
        return {
          ok: false,
          error: `OAuth connection "${parsed.connectionId}" has providerKey="${connection.providerKey}" but handle specifies "${parsed.providerKey}"`,
        };
      }
      return {
        ok: true,
        subject: {
          type: HandleType.LocalOAuth,
          handle: parsed,
          connection,
        },
      };
    }

    default:
      return {
        ok: false,
        error: `Handle type "${parsed.type}" is not a local handle and cannot be resolved by the local subject resolver`,
      };
  }
}
