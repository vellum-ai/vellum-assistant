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
 * **Credential records** (non-secret identity + policy)
 * - `get_credential_record` — Retrieve a credential record by account name
 * - `set_credential_record` — Store or update a credential record
 * - `delete_credential_record` — Delete a credential record by account name
 * - `list_credential_records` — List all credential records
 * - `bulk_set_credential_records` — Store multiple credential records at once
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
  /** Retrieve a single credential record (identity + policy) by account name. */
  GetCredentialRecord: "get_credential_record",
  /** Store or update a credential record by account name. */
  SetCredentialRecord: "set_credential_record",
  /** Delete a credential record by account name. */
  DeleteCredentialRecord: "delete_credential_record",
  /** List all credential records. */
  ListCredentialRecords: "list_credential_records",
  /** Bulk-import credential records. */
  BulkSetCredentialRecords: "bulk_set_credential_records",
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
// Credential records (identity + policy, never secret values)
// ---------------------------------------------------------------------------

export const CredentialInjectionTemplateSchema = z.object({
  hostPattern: z.string(),
  injectionType: z.enum(["header", "query"]),
  headerName: z.string().optional(),
  valuePrefix: z.string().optional(),
  queryParamName: z.string().optional(),
  composeWith: z
    .object({
      service: z.string(),
      field: z.string(),
      separator: z.string(),
    })
    .optional(),
  valueTransform: z.enum(["base64"]).optional(),
});
export type CredentialInjectionTemplate = z.infer<
  typeof CredentialInjectionTemplateSchema
>;

export const CredentialRecordSchema = z.object({
  credentialId: z.string(),
  service: z.string(),
  field: z.string(),
  allowedTools: z.array(z.string()),
  allowedDomains: z.array(z.string()),
  usageDescription: z.string().optional(),
  alias: z.string().optional(),
  injectionTemplates: z.array(CredentialInjectionTemplateSchema).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type CredentialRecord = z.infer<typeof CredentialRecordSchema>;

export const GetCredentialRecordSchema = z.object({
  /** The account name to look up (`credential/{service}/{field}`). */
  account: z.string(),
});
export type GetCredentialRecord = z.infer<typeof GetCredentialRecordSchema>;

export const GetCredentialRecordResponseSchema = z.object({
  found: z.boolean(),
  record: CredentialRecordSchema.optional(),
});
export type GetCredentialRecordResponse = z.infer<
  typeof GetCredentialRecordResponseSchema
>;

export const SetCredentialRecordSchema = z.object({
  account: z.string(),
  record: CredentialRecordSchema,
});
export type SetCredentialRecord = z.infer<typeof SetCredentialRecordSchema>;

export const SetCredentialRecordResponseSchema = z.object({
  ok: z.boolean(),
});
export type SetCredentialRecordResponse = z.infer<
  typeof SetCredentialRecordResponseSchema
>;

export const DeleteCredentialRecordSchema = z.object({
  account: z.string(),
});
export type DeleteCredentialRecord = z.infer<
  typeof DeleteCredentialRecordSchema
>;

export const DeleteCredentialRecordResponseSchema = z.object({
  result: z.enum(["deleted", "not-found", "error"]),
});
export type DeleteCredentialRecordResponse = z.infer<
  typeof DeleteCredentialRecordResponseSchema
>;

export const ListCredentialRecordsSchema = z.object({});
export type ListCredentialRecords = z.infer<typeof ListCredentialRecordsSchema>;

export const ListCredentialRecordsResponseSchema = z.object({
  records: z.array(
    z.object({
      account: z.string(),
      record: CredentialRecordSchema,
    }),
  ),
});
export type ListCredentialRecordsResponse = z.infer<
  typeof ListCredentialRecordsResponseSchema
>;

export const BulkSetCredentialRecordsSchema = z.object({
  records: z.array(
    z.object({
      account: z.string(),
      record: CredentialRecordSchema,
    }),
  ),
});
export type BulkSetCredentialRecords = z.infer<
  typeof BulkSetCredentialRecordsSchema
>;

export const BulkSetCredentialRecordsResponseSchema = z.object({
  results: z.array(
    z.object({
      account: z.string(),
      ok: z.boolean(),
    }),
  ),
});
export type BulkSetCredentialRecordsResponse = z.infer<
  typeof BulkSetCredentialRecordsResponseSchema
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
  [CesRpcMethod.GetCredentialRecord]: {
    request: GetCredentialRecord;
    response: GetCredentialRecordResponse;
  };
  [CesRpcMethod.SetCredentialRecord]: {
    request: SetCredentialRecord;
    response: SetCredentialRecordResponse;
  };
  [CesRpcMethod.DeleteCredentialRecord]: {
    request: DeleteCredentialRecord;
    response: DeleteCredentialRecordResponse;
  };
  [CesRpcMethod.ListCredentialRecords]: {
    request: ListCredentialRecords;
    response: ListCredentialRecordsResponse;
  };
  [CesRpcMethod.BulkSetCredentialRecords]: {
    request: BulkSetCredentialRecords;
    response: BulkSetCredentialRecordsResponse;
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
  [CesRpcMethod.GetCredentialRecord]: {
    request: GetCredentialRecordSchema,
    response: GetCredentialRecordResponseSchema,
  },
  [CesRpcMethod.SetCredentialRecord]: {
    request: SetCredentialRecordSchema,
    response: SetCredentialRecordResponseSchema,
  },
  [CesRpcMethod.DeleteCredentialRecord]: {
    request: DeleteCredentialRecordSchema,
    response: DeleteCredentialRecordResponseSchema,
  },
  [CesRpcMethod.ListCredentialRecords]: {
    request: ListCredentialRecordsSchema,
    response: ListCredentialRecordsResponseSchema,
  },
  [CesRpcMethod.BulkSetCredentialRecords]: {
    request: BulkSetCredentialRecordsSchema,
    response: BulkSetCredentialRecordsResponseSchema,
  },
} as const;
