/**
 * CES RPC method contracts.
 *
 * Defines the request and response schemas for every RPC method in the
 * assistant-to-CES wire protocol. Each method has a canonical string
 * name, a request schema, and a response schema.
 *
 * Methods:
 *
 * **Lifecycle**
 * - `update_managed_credential` — Push an updated API key to CES after hatch
 *
 * **Credential CRUD**
 * - `get_credential` — Retrieve a credential by account name
 * - `set_credential` — Store or update a credential
 * - `delete_credential` — Delete a credential by account name
 * - `list_credentials` — List all credential account names
 * - `bulk_set_credentials` — Store multiple credentials at once
 *
 * **Credential probes**
 * - `probe_model_access`: call a provider's model-listing endpoint with a
 *   stored credential and report which models it can reach
 */

import { z } from "zod";
import { RpcErrorSchema } from "./error.js";

// ---------------------------------------------------------------------------
// Method name constants
// ---------------------------------------------------------------------------

export const CesRpcMethod = {
  /** Push an updated assistant credential to CES after post-hatch provisioning. */
  UpdateManagedCredential: "update_managed_credential",
  /** Retrieve a single credential by account name. */
  GetCredential: "get_credential",
  /** Store or update a credential by account name. */
  SetCredential: "set_credential",
  /** Delete a credential by account name. */
  DeleteCredential: "delete_credential",
  /** List all credential account names. */
  ListCredentials: "list_credentials",
  /** Bulk-import credentials (set multiple at once). */
  BulkSetCredentials: "bulk_set_credentials",
  /** Probe a provider's model-listing endpoint with a stored credential. */
  ProbeModelAccess: "probe_model_access",
} as const;

export type CesRpcMethod = (typeof CesRpcMethod)[keyof typeof CesRpcMethod];

// ---------------------------------------------------------------------------
// update_managed_credential
// ---------------------------------------------------------------------------

export const UpdateManagedCredentialSchema = z.object({
  /** The assistant API key to push to CES for platform credential materialization. */
  assistantApiKey: z.string(), // nosemgrep: not-a-secret
  /**
   * Optional platform assistant ID. In warm-pool mode the ID may not be
   * available at CES startup; the assistant pushes it here once provisioned.
   */
  assistantId: z.string().optional(),
});
export type UpdateManagedCredential = z.infer<
  typeof UpdateManagedCredentialSchema
>;

export const UpdateManagedCredentialResponseSchema = z.object({
  /** Whether the managed credential was successfully updated. */
  updated: z.boolean(),
});
export type UpdateManagedCredentialResponse = z.infer<
  typeof UpdateManagedCredentialResponseSchema
>;

// ---------------------------------------------------------------------------
// get_credential
// ---------------------------------------------------------------------------

export const GetCredentialSchema = z.object({
  /** The account name to look up. */
  account: z.string(),
});
export type GetCredential = z.infer<typeof GetCredentialSchema>;

export const GetCredentialResponseSchema = z.object({
  /** Whether the credential was found. */
  found: z.boolean(),
  /** The credential value (present only when found). */
  value: z.string().optional(),
});
export type GetCredentialResponse = z.infer<typeof GetCredentialResponseSchema>;

// ---------------------------------------------------------------------------
// set_credential
// ---------------------------------------------------------------------------

export const SetCredentialSchema = z.object({
  /** The account name to store the credential under. */
  account: z.string(),
  /** The credential value to store. */
  value: z.string(),
});
export type SetCredential = z.infer<typeof SetCredentialSchema>;

export const SetCredentialResponseSchema = z.object({
  /** Whether the credential was successfully stored. */
  ok: z.boolean(),
});
export type SetCredentialResponse = z.infer<typeof SetCredentialResponseSchema>;

// ---------------------------------------------------------------------------
// delete_credential
// ---------------------------------------------------------------------------

export const DeleteCredentialSchema = z.object({
  /** The account name to delete. */
  account: z.string(),
});
export type DeleteCredential = z.infer<typeof DeleteCredentialSchema>;

export const DeleteCredentialResponseSchema = z.object({
  /** The result of the delete operation. */
  result: z.enum(["deleted", "not-found", "error"]),
});
export type DeleteCredentialResponse = z.infer<
  typeof DeleteCredentialResponseSchema
>;

// ---------------------------------------------------------------------------
// list_credentials
// ---------------------------------------------------------------------------

export const ListCredentialsSchema = z.object({});
export type ListCredentials = z.infer<typeof ListCredentialsSchema>;

export const ListCredentialsResponseSchema = z.object({
  /** The account names of all stored credentials. */
  accounts: z.array(z.string()),
});
export type ListCredentialsResponse = z.infer<
  typeof ListCredentialsResponseSchema
>;

// ---------------------------------------------------------------------------
// bulk_set_credentials
// ---------------------------------------------------------------------------

export const BulkSetCredentialsSchema = z.object({
  /** Array of credentials to set in bulk. */
  credentials: z.array(
    z.object({
      /** The account name to store the credential under. */
      account: z.string(),
      /** The credential value to store. */
      value: z.string(),
    }),
  ),
});
export type BulkSetCredentials = z.infer<typeof BulkSetCredentialsSchema>;

export const BulkSetCredentialsResponseSchema = z.object({
  /** Per-credential results indicating success or failure. */
  results: z.array(
    z.object({
      /** The account name that was set. */
      account: z.string(),
      /** Whether the credential was successfully stored. */
      ok: z.boolean(),
    }),
  ),
});
export type BulkSetCredentialsResponse = z.infer<
  typeof BulkSetCredentialsResponseSchema
>;

// ---------------------------------------------------------------------------
// probe_model_access
// ---------------------------------------------------------------------------

/**
 * Where the stored credential is injected into the outbound probe request.
 * The caller names the slot; the value is read inside CES and never crosses
 * the wire back to the caller.
 */
export const CredentialInjectionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("header"),
    /** Header name (e.g. `x-api-key`, `authorization`). */
    name: z.string().min(1),
    /** Prefix placed before the credential value (e.g. `Bearer `). */
    prefix: z.string().optional(),
  }),
  z.object({
    kind: z.literal("query"),
    /** Query parameter name (e.g. `key` for the Gemini API). */
    name: z.string().min(1),
  }),
]);
export type CredentialInjection = z.infer<typeof CredentialInjectionSchema>;

export const ProbeModelAccessSchema = z.object({
  /** Account name of the stored credential to probe with. */
  account: z.string(),
  /** The provider's model-listing request, minus the credential. */
  request: z.object({
    /** Absolute http(s) URL of the model-listing endpoint. */
    url: z.string(),
    /** Static headers to send (never carries credential material). */
    headers: z.record(z.string(), z.string()).optional(),
    credentialInjection: CredentialInjectionSchema,
  }),
  /** Model ids to check against the listing response. */
  models: z.array(z.string()),
});
export type ProbeModelAccess = z.infer<typeof ProbeModelAccessSchema>;

/**
 * Whether the stored credential authenticated against the provider.
 *
 * - `valid`: the provider accepted the credential and returned a listing.
 * - `invalid`: the provider rejected the credential (401/403).
 * - `missing_credential`: no credential is stored under the account.
 * - `inconclusive`: the probe could not decide (network error, rate limit,
 *   provider 5xx, unparseable body).
 */
export const ProbeOutcomeSchema = z.enum([
  "valid",
  "invalid",
  "missing_credential",
  "inconclusive",
]);
export type ProbeOutcome = z.infer<typeof ProbeOutcomeSchema>;

/**
 * Per-model verdict. `unknown` whenever the listing itself did not come
 * back, so a failed probe never reads as "model missing".
 */
export const ModelAccessSchema = z.enum([
  "accessible",
  "not_accessible",
  "unknown",
]);
export type ModelAccess = z.infer<typeof ModelAccessSchema>;

export const ProbeModelAccessResponseSchema = z.object({
  outcome: ProbeOutcomeSchema,
  /** HTTP status returned by the provider, when the request completed. */
  status: z.number().int().optional(),
  /** Redacted, truncated provider error text for a failed probe. */
  detail: z.string().optional(),
  /** Model ids the credential can reach, as reported by the provider. */
  accessibleModels: z.array(z.string()),
  /** Verdict for each model the caller asked about. */
  models: z.array(
    z.object({
      model: z.string(),
      access: ModelAccessSchema,
    }),
  ),
});
export type ProbeModelAccessResponse = z.infer<
  typeof ProbeModelAccessResponseSchema
>;

// ---------------------------------------------------------------------------
// Full RPC contract type map
// ---------------------------------------------------------------------------

/**
 * Type-level mapping from RPC method names to their request and response
 * schemas. Useful for building type-safe RPC dispatch layers.
 */
export interface CesRpcContract {
  [CesRpcMethod.UpdateManagedCredential]: {
    request: UpdateManagedCredential;
    response: UpdateManagedCredentialResponse;
  };
  [CesRpcMethod.GetCredential]: {
    request: GetCredential;
    response: GetCredentialResponse;
  };
  [CesRpcMethod.SetCredential]: {
    request: SetCredential;
    response: SetCredentialResponse;
  };
  [CesRpcMethod.DeleteCredential]: {
    request: DeleteCredential;
    response: DeleteCredentialResponse;
  };
  [CesRpcMethod.ListCredentials]: {
    request: ListCredentials;
    response: ListCredentialsResponse;
  };
  [CesRpcMethod.BulkSetCredentials]: {
    request: BulkSetCredentials;
    response: BulkSetCredentialsResponse;
  };
  [CesRpcMethod.ProbeModelAccess]: {
    request: ProbeModelAccess;
    response: ProbeModelAccessResponse;
  };
}

/**
 * Schema lookup map for runtime validation of RPC payloads.
 */
export const CesRpcSchemas = {
  [CesRpcMethod.UpdateManagedCredential]: {
    request: UpdateManagedCredentialSchema,
    response: UpdateManagedCredentialResponseSchema,
  },
  [CesRpcMethod.GetCredential]: {
    request: GetCredentialSchema,
    response: GetCredentialResponseSchema,
  },
  [CesRpcMethod.SetCredential]: {
    request: SetCredentialSchema,
    response: SetCredentialResponseSchema,
  },
  [CesRpcMethod.DeleteCredential]: {
    request: DeleteCredentialSchema,
    response: DeleteCredentialResponseSchema,
  },
  [CesRpcMethod.ListCredentials]: {
    request: ListCredentialsSchema,
    response: ListCredentialsResponseSchema,
  },
  [CesRpcMethod.BulkSetCredentials]: {
    request: BulkSetCredentialsSchema,
    response: BulkSetCredentialsResponseSchema,
  },
  [CesRpcMethod.ProbeModelAccess]: {
    request: ProbeModelAccessSchema,
    response: ProbeModelAccessResponseSchema,
  },
} as const;
