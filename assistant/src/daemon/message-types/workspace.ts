// Workspace file, identity, and tool permission types.

// === Client → Server ===

export interface WorkspaceFilesListRequest {
  type: "workspace_files_list";
}

export interface WorkspaceFileReadRequest {
  type: "workspace_file_read";
  /** Relative path within the workspace directory (e.g. "IDENTITY.md"). */
  path: string;
}

export interface IdentityGetRequest {
  type: "identity_get";
}

export interface ToolPermissionSimulateRequest {
  type: "tool_permission_simulate";
  /** Tool name to simulate (e.g. 'bash', 'file_write'). */
  toolName: string;
  /** Tool input record to simulate. */
  input: Record<string, unknown>;
  /** Working directory context; defaults to daemon cwd when omitted. */
  workingDir?: string;
  /** Whether the simulated context is interactive (default true). */
  isInteractive?: boolean;
}

export interface ToolNamesListRequest {
  type: "tool_names_list";
}

// === Server → Client ===

export interface WorkspaceFilesListResponse {
  type: "workspace_files_list_response";
  files: Array<{
    /** Relative path within the workspace (e.g. "IDENTITY.md", "skills/my-skill"). */
    path: string;
    /** Display name (e.g. "IDENTITY.md"). */
    name: string;
    /** Whether the file/directory exists. */
    exists: boolean;
  }>;
}

export interface WorkspaceFileReadResponse {
  type: "workspace_file_read_response";
  path: string;
  content: string | null;
  error?: string;
}

export interface IdentityGetResponse {
  type: "identity_get_response";
  /** Whether an IDENTITY.md file was found. When false, all fields are empty defaults. */
  found: boolean;
  name: string;
  role: string;
  personality: string;
  emoji: string;
  home: string;
  version?: string;
  assistantId?: string;
  createdAt?: string;
  originSystem?: string;
}

export interface ToolPermissionSimulateResponse {
  type: "tool_permission_simulate_response";
  success: boolean;
  /** The simulated permission decision. */
  decision?: "allow" | "deny" | "prompt";
  /** Risk level of the simulated tool invocation. */
  riskLevel?: string;
  /** Human-readable reason for the decision. */
  reason?: string;
  /** When decision is 'prompt', the data needed to render a ToolConfirmationBubble. */
  promptPayload?: {
    allowlistOptions: Array<{
      label: string;
      description: string;
      pattern: string;
    }>;
    scopeOptions: Array<{ label: string; scope: string }>;
    persistentDecisionsAllowed: boolean;
  };
  /** Resolved execution target for the tool. */
  executionTarget?: "host" | "sandbox";
  /** ID of the trust rule that matched (if any). */
  matchedTrustRuleId?: string;
  /** Error message when success is false. */
  error?: string;
}

export interface ToolInputSchema {
  type: "object";
  properties?: Record<
    string,
    {
      type?: string;
      description?: string;
      enum?: string[];
      [key: string]: unknown;
    }
  >;
  required?: string[];
}

export interface ToolNamesListResponse {
  type: "tool_names_list_response";
  /** Sorted list of all registered tool names. */
  names: string[];
  /** Input schemas keyed by tool name. */
  schemas?: Record<string, ToolInputSchema>;
}

/** Server push — broadcast when IDENTITY.md changes on disk. */
export interface IdentityChanged {
  type: "identity_changed";
  name: string;
  role: string;
  personality: string;
  emoji: string;
  home: string;
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _WorkspaceClientMessages =
  | WorkspaceFilesListRequest
  | WorkspaceFileReadRequest
  | IdentityGetRequest
  | ToolPermissionSimulateRequest
  | ToolNamesListRequest;

export type _WorkspaceServerMessages =
  | WorkspaceFilesListResponse
  | WorkspaceFileReadResponse
  | IdentityGetResponse
  | ToolPermissionSimulateResponse
  | ToolNamesListResponse
  | IdentityChanged;
