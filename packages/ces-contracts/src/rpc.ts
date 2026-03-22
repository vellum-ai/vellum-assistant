/**
 * CES RPC method contracts.
 *
 * Defines the request and response schemas for every RPC method in the
 * assistant-to-CES wire protocol. Each method has a canonical string
 * name, a request schema, and a response schema.
 *
 * Methods:
 *
 * **Tool execution**
 * - `make_authenticated_request` — Execute an authenticated HTTP request
 * - `run_authenticated_command` — Execute a command with credential env vars
 * - `manage_secure_command_tool` — Register/unregister a secure command tool
 *
 * **Approval flow**
 * - `approval_required` — CES notifies the assistant that approval is needed
 * - `record_grant` — Record a grant decision after guardian approval
 *
 * **Grant management**
 * - `list_grants` — List grants for a CES connection
 * - `revoke_grant` — Revoke a specific grant
 *
 * **Audit**
 * - `list_audit_records` — List audit records for inspection
 *
 * **Lifecycle**
 * - `update_managed_credential` — Push an updated API key to CES after hatch
 *
 * **Credential CRUD**
 * - `get_credential` — Retrieve a credential by account name
 * - `set_credential` — Store or update a credential
 * - `delete_credential` — Delete a credential by account name
 * - `list_credentials` — List all credential account names
 */

import { z } from "zod/v4";
import {
  AuditRecordSummarySchema,
  GrantProposalSchema,
  PersistentGrantRecordSchema,
  TemporaryGrantDecisionSchema,
} from "./grants.js";
import { RpcErrorSchema } from "./error.js";

// ---------------------------------------------------------------------------
// Method name constants
// ---------------------------------------------------------------------------

export const CesRpcMethod = {
  MakeAuthenticatedRequest: "make_authenticated_request",
  RunAuthenticatedCommand: "run_authenticated_command",
  ManageSecureCommandTool: "manage_secure_command_tool",
  ApprovalRequired: "approval_required",
  RecordGrant: "record_grant",
  ListGrants: "list_grants",
  RevokeGrant: "revoke_grant",
  ListAuditRecords: "list_audit_records",
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
} as const;

export type CesRpcMethod =
  (typeof CesRpcMethod)[keyof typeof CesRpcMethod];

// ---------------------------------------------------------------------------
// make_authenticated_request
// ---------------------------------------------------------------------------

export const MakeAuthenticatedRequestSchema = z.object({
  /** CES credential handle to use for authentication. */
  credentialHandle: z.string(),
  /** HTTP method. */
  method: z.string(),
  /** Target URL. */
  url: z.string(),
  /** Optional request headers (credential headers are injected by CES). */
  headers: z.record(z.string(), z.string()).optional(),
  /** Optional request body (string or JSON-serialisable). */
  body: z.unknown().optional(),
  /** Human-readable purpose for audit logging. */
  purpose: z.string(),
  /** Existing grant ID to consume, if the caller holds one. */
  grantId: z.string().optional(),
  /** Conversation ID for conversation-scoped temporary grants. */
  conversationId: z.string().optional(),
});
export type MakeAuthenticatedRequest = z.infer<
  typeof MakeAuthenticatedRequestSchema
>;

export const MakeAuthenticatedRequestResponseSchema = z.object({
  /** Whether the request was executed (not whether the HTTP call succeeded). */
  success: z.boolean(),
  /** HTTP status code returned by the target. */
  statusCode: z.number().optional(),
  /** Response headers. */
  responseHeaders: z.record(z.string(), z.string()).optional(),
  /** Response body (string). */
  responseBody: z.string().optional(),
  /** Structured error if execution failed. */
  error: RpcErrorSchema.optional(),
  /** Audit record ID for this execution. */
  auditId: z.string().optional(),
});
export type MakeAuthenticatedRequestResponse = z.infer<
  typeof MakeAuthenticatedRequestResponseSchema
>;

// ---------------------------------------------------------------------------
// run_authenticated_command
// ---------------------------------------------------------------------------

/**
 * A file to stage from the assistant workspace into the CES scratch directory.
 */
const WorkspaceInputSchema = z.object({
  /** Relative path within the assistant workspace directory. */
  workspacePath: z.string(),
});

/**
 * A file the command produces in the scratch directory that should be
 * copied back to the assistant workspace after execution.
 */
const WorkspaceOutputSchema = z.object({
  /** Relative path within the scratch directory where the command writes output. */
  scratchPath: z.string(),
  /** Relative path within the assistant workspace where the output is copied. */
  workspacePath: z.string(),
});

export const RunAuthenticatedCommandSchema = z.object({
  /** CES credential handle to use for environment injection. */
  credentialHandle: z.string(),
  /** Secure command reference in format '<bundleDigest>/<profileName> [argv...]'. Only manifest-driven secure commands are supported. */
  command: z.string(),
  /** Optional path used for resolving workspace input/output staging, not as the actual execution working directory (CES always runs commands in the scratch directory). */
  cwd: z.string().optional(),
  /** Workspace files to stage as read-only inputs in the CES scratch directory. */
  inputs: z.array(WorkspaceInputSchema).optional(),
  /** Workspace files to copy back from the CES scratch directory after execution. */
  outputs: z.array(WorkspaceOutputSchema).optional(),
  /** Human-readable purpose for audit logging. */
  purpose: z.string(),
  /** Existing grant ID to consume, if the caller holds one. */
  grantId: z.string().optional(),
  /** Conversation ID for conversation-scoped temporary grants. */
  conversationId: z.string().optional(),
});
export type RunAuthenticatedCommand = z.infer<
  typeof RunAuthenticatedCommandSchema
>;

export const RunAuthenticatedCommandResponseSchema = z.object({
  /** Whether the command was executed. */
  success: z.boolean(),
  /** Process exit code. */
  exitCode: z.number().optional(),
  /** Combined stdout output. */
  stdout: z.string().optional(),
  /** Combined stderr output. */
  stderr: z.string().optional(),
  /** Structured error if execution failed. */
  error: RpcErrorSchema.optional(),
  /** Audit record ID for this execution. */
  auditId: z.string().optional(),
});
export type RunAuthenticatedCommandResponse = z.infer<
  typeof RunAuthenticatedCommandResponseSchema
>;

// ---------------------------------------------------------------------------
// manage_secure_command_tool
// ---------------------------------------------------------------------------

export const ManageSecureCommandToolAction = {
  Register: "register",
  Unregister: "unregister",
} as const;

export type ManageSecureCommandToolAction =
  (typeof ManageSecureCommandToolAction)[keyof typeof ManageSecureCommandToolAction];

/**
 * Zod schema for allowed argv patterns within a command profile.
 */
const AllowedArgvPatternSchema = z.object({
  name: z.string(),
  tokens: z.array(z.string()),
});

/**
 * Zod schema for allowed network targets within a command profile.
 */
const AllowedNetworkTargetSchema = z.object({
  hostPattern: z.string(),
  ports: z.array(z.number()).optional(),
  protocols: z.array(z.enum(["http", "https"])).optional(),
});

/**
 * Zod schema for a single command profile within a secure command manifest.
 */
const CommandProfileSchema = z.object({
  description: z.string(),
  allowedArgvPatterns: z.array(AllowedArgvPatternSchema),
  deniedSubcommands: z.array(z.string()),
  deniedFlags: z.array(z.string()).optional(),
  allowedNetworkTargets: z.array(AllowedNetworkTargetSchema).optional(),
});

/**
 * Zod schema for auth adapter configuration (discriminated union on `type`).
 */
const AuthAdapterConfigSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("env_var"),
    envVarName: z.string(),
    valuePrefix: z.string().optional(),
  }),
  z.object({
    type: z.literal("temp_file"),
    envVarName: z.string(),
    fileExtension: z.string().optional(),
    fileMode: z.number().optional(),
  }),
  z.object({
    type: z.literal("credential_process"),
    envVarName: z.string(),
    helperCommand: z.string(),
    timeoutMs: z.number().optional(),
  }),
]);

/**
 * Zod schema for the full secure command manifest passed during register.
 * This mirrors the {@link SecureCommandManifest} interface in
 * `credential-executor/src/commands/profiles.ts`.
 */
export const SecureCommandManifestSchema = z.object({
  schemaVersion: z.string(),
  bundleDigest: z.string(),
  bundleId: z.string(),
  version: z.string(),
  entrypoint: z.string(),
  commandProfiles: z.record(z.string(), CommandProfileSchema),
  authAdapter: AuthAdapterConfigSchema,
  egressMode: z.enum(["proxy_required", "no_network"]),
  cleanConfigDirs: z.record(z.string(), z.string()).optional(),
});

export const ManageSecureCommandToolSchema = z.object({
  /** Whether to register or unregister the tool. */
  action: z.enum(["register", "unregister"]),
  /** Tool name to register/unregister. */
  toolName: z.string(),
  /** CES credential handle the tool should use (required for register). */
  credentialHandle: z.string().optional(),
  /** Human-readable description of the tool (required for register). */
  description: z.string().optional(),
  /** Bundle identifier for the secure command package (required for register). */
  bundleId: z.string().optional(),
  /** Semantic version of the bundle to install (required for register). */
  version: z.string().optional(),
  /** HTTPS URL from which CES will download the bundle (required for register). */
  sourceUrl: z.string().optional(),
  /** SHA-256 hex digest of the bundle for integrity verification (required for register). */
  sha256: z.string().optional(),
  /**
   * Full secure command manifest for the bundle (required for register).
   * Contains entrypoint, command profiles, auth adapter, egress mode, etc.
   * CES validates this manifest before publishing the bundle.
   */
  secureCommandManifest: SecureCommandManifestSchema.optional(),
});
export type ManageSecureCommandTool = z.infer<
  typeof ManageSecureCommandToolSchema
>;

export const ManageSecureCommandToolResponseSchema = z.object({
  /** Whether the operation succeeded. */
  success: z.boolean(),
  /** Structured error if the operation failed. */
  error: RpcErrorSchema.optional(),
});
export type ManageSecureCommandToolResponse = z.infer<
  typeof ManageSecureCommandToolResponseSchema
>;

// ---------------------------------------------------------------------------
// approval_required (CES → assistant notification)
// ---------------------------------------------------------------------------

export const ApprovalRequiredSchema = z.object({
  /** The proposal that requires approval. */
  proposal: GrantProposalSchema,
  /** Deterministic hash of the proposal. */
  proposalHash: z.string(),
  /** Human-readable rendering of the proposal. */
  renderedProposal: z.string(),
  /** The CES connection requesting approval. */
  sessionId: z.string(),
  /** The conversation ID for conversation-scoped grants. */
  conversationId: z.string().optional(),
});
export type ApprovalRequired = z.infer<typeof ApprovalRequiredSchema>;

export const ApprovalRequiredResponseSchema = z.object({
  /** Whether the assistant acknowledged the approval request. */
  acknowledged: z.boolean(),
});
export type ApprovalRequiredResponse = z.infer<
  typeof ApprovalRequiredResponseSchema
>;

// ---------------------------------------------------------------------------
// record_grant
// ---------------------------------------------------------------------------

export const RecordGrantSchema = z.object({
  /** The grant decision from the guardian. */
  decision: TemporaryGrantDecisionSchema,
  /** The CES connection this grant applies to. */
  sessionId: z.string(),
  /** The conversation ID for conversation-scoped grants. */
  conversationId: z.string().optional(),
});
export type RecordGrant = z.infer<typeof RecordGrantSchema>;

export const RecordGrantResponseSchema = z.object({
  /** Whether the grant was successfully recorded. */
  success: z.boolean(),
  /** The persisted grant record (when approved and recorded). */
  grant: PersistentGrantRecordSchema.optional(),
  /** Structured error if recording failed. */
  error: RpcErrorSchema.optional(),
});
export type RecordGrantResponse = z.infer<typeof RecordGrantResponseSchema>;

// ---------------------------------------------------------------------------
// list_grants
// ---------------------------------------------------------------------------

export const ListGrantsSchema = z.object({
  /** Filter by CES connection ID. */
  sessionId: z.string().optional(),
  /** Filter by credential handle. */
  credentialHandle: z.string().optional(),
  /** Filter by grant status. */
  status: z
    .enum(["active", "expired", "revoked", "consumed"])
    .optional(),
});
export type ListGrants = z.infer<typeof ListGrantsSchema>;

export const ListGrantsResponseSchema = z.object({
  /** List of matching grant records. */
  grants: z.array(PersistentGrantRecordSchema),
});
export type ListGrantsResponse = z.infer<typeof ListGrantsResponseSchema>;

// ---------------------------------------------------------------------------
// revoke_grant
// ---------------------------------------------------------------------------

export const RevokeGrantSchema = z.object({
  /** The grant to revoke. */
  grantId: z.string(),
  /** Human-readable reason for revocation. */
  reason: z.string().optional(),
});
export type RevokeGrant = z.infer<typeof RevokeGrantSchema>;

export const RevokeGrantResponseSchema = z.object({
  /** Whether the grant was successfully revoked. */
  success: z.boolean(),
  /** Structured error if revocation failed. */
  error: RpcErrorSchema.optional(),
});
export type RevokeGrantResponse = z.infer<typeof RevokeGrantResponseSchema>;

// ---------------------------------------------------------------------------
// list_audit_records
// ---------------------------------------------------------------------------

export const ListAuditRecordsSchema = z.object({
  /** Filter by CES connection ID. */
  sessionId: z.string().optional(),
  /** Filter by credential handle. */
  credentialHandle: z.string().optional(),
  /** Filter by grant ID. */
  grantId: z.string().optional(),
  /** Maximum number of records to return. */
  limit: z.number().optional(),
  /** Cursor for pagination (opaque string from a previous response). */
  cursor: z.string().optional(),
});
export type ListAuditRecords = z.infer<typeof ListAuditRecordsSchema>;

export const ListAuditRecordsResponseSchema = z.object({
  /** List of matching audit record summaries. */
  records: z.array(AuditRecordSummarySchema),
  /** Cursor for the next page (null if no more results). */
  nextCursor: z.string().nullable(),
});
export type ListAuditRecordsResponse = z.infer<
  typeof ListAuditRecordsResponseSchema
>;

// ---------------------------------------------------------------------------
// update_managed_credential
// ---------------------------------------------------------------------------

export const UpdateManagedCredentialSchema = z.object({
  /** The assistant API key to push to CES for platform credential materialization. */
  assistantApiKey: z.string(), // nosemgrep: not-a-secret
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
export type GetCredentialResponse = z.infer<
  typeof GetCredentialResponseSchema
>;

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
export type SetCredentialResponse = z.infer<
  typeof SetCredentialResponseSchema
>;

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
// Full RPC contract type map
// ---------------------------------------------------------------------------

/**
 * Type-level mapping from RPC method names to their request and response
 * schemas. Useful for building type-safe RPC dispatch layers.
 */
export interface CesRpcContract {
  [CesRpcMethod.MakeAuthenticatedRequest]: {
    request: MakeAuthenticatedRequest;
    response: MakeAuthenticatedRequestResponse;
  };
  [CesRpcMethod.RunAuthenticatedCommand]: {
    request: RunAuthenticatedCommand;
    response: RunAuthenticatedCommandResponse;
  };
  [CesRpcMethod.ManageSecureCommandTool]: {
    request: ManageSecureCommandTool;
    response: ManageSecureCommandToolResponse;
  };
  [CesRpcMethod.ApprovalRequired]: {
    request: ApprovalRequired;
    response: ApprovalRequiredResponse;
  };
  [CesRpcMethod.RecordGrant]: {
    request: RecordGrant;
    response: RecordGrantResponse;
  };
  [CesRpcMethod.ListGrants]: {
    request: ListGrants;
    response: ListGrantsResponse;
  };
  [CesRpcMethod.RevokeGrant]: {
    request: RevokeGrant;
    response: RevokeGrantResponse;
  };
  [CesRpcMethod.ListAuditRecords]: {
    request: ListAuditRecords;
    response: ListAuditRecordsResponse;
  };
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
}

/**
 * Schema lookup map for runtime validation of RPC payloads.
 */
export const CesRpcSchemas = {
  [CesRpcMethod.MakeAuthenticatedRequest]: {
    request: MakeAuthenticatedRequestSchema,
    response: MakeAuthenticatedRequestResponseSchema,
  },
  [CesRpcMethod.RunAuthenticatedCommand]: {
    request: RunAuthenticatedCommandSchema,
    response: RunAuthenticatedCommandResponseSchema,
  },
  [CesRpcMethod.ManageSecureCommandTool]: {
    request: ManageSecureCommandToolSchema,
    response: ManageSecureCommandToolResponseSchema,
  },
  [CesRpcMethod.ApprovalRequired]: {
    request: ApprovalRequiredSchema,
    response: ApprovalRequiredResponseSchema,
  },
  [CesRpcMethod.RecordGrant]: {
    request: RecordGrantSchema,
    response: RecordGrantResponseSchema,
  },
  [CesRpcMethod.ListGrants]: {
    request: ListGrantsSchema,
    response: ListGrantsResponseSchema,
  },
  [CesRpcMethod.RevokeGrant]: {
    request: RevokeGrantSchema,
    response: RevokeGrantResponseSchema,
  },
  [CesRpcMethod.ListAuditRecords]: {
    request: ListAuditRecordsSchema,
    response: ListAuditRecordsResponseSchema,
  },
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
} as const;
