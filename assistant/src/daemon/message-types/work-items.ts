// Work item (task queue) types.

// === Client → Server ===

export interface WorkItemsListRequest {
  type: "work_items_list";
  status?: string; // optional filter
}

export interface WorkItemGetRequest {
  type: "work_item_get";
  id: string;
}

export interface WorkItemUpdateRequest {
  type: "work_item_update";
  id: string;
  title?: string;
  notes?: string;
  status?: string;
  priorityTier?: number;
  sortIndex?: number;
}

export interface WorkItemCompleteRequest {
  type: "work_item_complete";
  id: string;
}

export interface WorkItemDeleteRequest {
  type: "work_item_delete";
  id: string;
}

export interface WorkItemRunTaskRequest {
  type: "work_item_run_task";
  id: string;
}

export interface WorkItemOutputRequest {
  type: "work_item_output";
  id: string;
}

export interface WorkItemPreflightRequest {
  type: "work_item_preflight";
  id: string; // work item ID
}

export interface WorkItemApprovePermissionsRequest {
  type: "work_item_approve_permissions";
  id: string;
  approvedTools: string[]; // tools the user approved
}

export interface WorkItemCancelRequest {
  type: "work_item_cancel";
  id: string;
}

// === Server → Client ===

export interface WorkItemsListResponse {
  type: "work_items_list_response";
  items: Array<{
    id: string;
    taskId: string;
    title: string;
    notes: string | null;
    status: string;
    priorityTier: number;
    sortIndex: number | null;
    lastRunId: string | null;
    lastRunConversationId: string | null;
    lastRunStatus: string | null;
    sourceType: string | null;
    sourceId: string | null;
    createdAt: number;
    updatedAt: number;
  }>;
}

export interface WorkItemGetResponse {
  type: "work_item_get_response";
  item: {
    id: string;
    taskId: string;
    title: string;
    notes: string | null;
    status: string;
    priorityTier: number;
    sortIndex: number | null;
    lastRunId: string | null;
    lastRunConversationId: string | null;
    lastRunStatus: string | null;
    sourceType: string | null;
    sourceId: string | null;
    createdAt: number;
    updatedAt: number;
  } | null;
}

export interface WorkItemUpdateResponse {
  type: "work_item_update_response";
  item: {
    id: string;
    taskId: string;
    title: string;
    notes: string | null;
    status: string;
    priorityTier: number;
    sortIndex: number | null;
    lastRunId: string | null;
    lastRunConversationId: string | null;
    lastRunStatus: string | null;
    sourceType: string | null;
    sourceId: string | null;
    createdAt: number;
    updatedAt: number;
  } | null;
}

export interface WorkItemDeleteResponse {
  type: "work_item_delete_response";
  id: string;
  success: boolean;
}

export type WorkItemRunTaskErrorCode =
  | "not_found"
  | "already_running"
  | "invalid_status"
  | "no_task"
  | "permission_required";

export interface WorkItemRunTaskResponse {
  type: "work_item_run_task_response";
  id: string;
  lastRunId: string;
  success: boolean;
  error?: string;
  /** Structured error code so the client can deterministically re-enable buttons or show contextual UI. */
  errorCode?: WorkItemRunTaskErrorCode;
}

export interface WorkItemOutputResponse {
  type: "work_item_output_response";
  id: string;
  success: boolean;
  error?: string;
  output?: {
    title: string;
    status: string;
    runId: string | null;
    conversationId: string | null;
    completedAt: number | null;
    summary: string;
    highlights: string[];
  };
}

export interface WorkItemPreflightResponse {
  type: "work_item_preflight_response";
  id: string;
  success: boolean;
  error?: string;
  permissions?: {
    tool: string;
    description: string;
    riskLevel: "low" | "medium" | "high";
    currentDecision: "allow" | "deny" | "prompt";
  }[];
}

export interface WorkItemApprovePermissionsResponse {
  type: "work_item_approve_permissions_response";
  id: string;
  success: boolean;
  error?: string;
}

export interface WorkItemCancelResponse {
  type: "work_item_cancel_response";
  id: string;
  success: boolean;
  error?: string;
}

/** Server push — lightweight invalidation signal: the task queue has been mutated, refetch your list. */
export interface TasksChanged {
  type: "tasks_changed";
}

/** Server push — broadcast when a work item status changes (e.g. running -> awaiting_review). */
export interface WorkItemStatusChanged {
  type: "work_item_status_changed";
  item: {
    id: string;
    taskId: string;
    title: string;
    status: string;
    lastRunId: string | null;
    lastRunConversationId: string | null;
    lastRunStatus: string | null;
    updatedAt: number;
  };
}

/** Server push — broadcast when a task run creates a conversation. */
export interface TaskRunConversationCreated {
  type: "task_run_conversation_created";
  conversationId: string;
  workItemId: string;
  title: string;
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _WorkItemsClientMessages =
  | WorkItemsListRequest
  | WorkItemGetRequest
  | WorkItemUpdateRequest
  | WorkItemCompleteRequest
  | WorkItemDeleteRequest
  | WorkItemRunTaskRequest
  | WorkItemOutputRequest
  | WorkItemPreflightRequest
  | WorkItemApprovePermissionsRequest
  | WorkItemCancelRequest;

export type _WorkItemsServerMessages =
  | WorkItemsListResponse
  | WorkItemGetResponse
  | WorkItemUpdateResponse
  | WorkItemDeleteResponse
  | WorkItemRunTaskResponse
  | WorkItemOutputResponse
  | WorkItemPreflightResponse
  | WorkItemApprovePermissionsResponse
  | WorkItemCancelResponse
  | WorkItemStatusChanged
  | TaskRunConversationCreated
  | TasksChanged;
