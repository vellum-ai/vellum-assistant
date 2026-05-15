/**
 * A2A v1.0 protocol type definitions.
 *
 * Implemented directly from the A2A spec — no SDK dependency.
 * See https://google.github.io/A2A/
 */

// ── Agent Card ──────────────────────────────────────────────────────

export interface AgentCard {
  name: string;
  description: string;
  version: string;
  supported_interfaces: AgentInterface[];
  capabilities: AgentCapabilities;
  default_input_modes: string[];
  default_output_modes: string[];
  skills: AgentSkill[];
  security_schemes?: Record<string, unknown>;
  security_requirements?: Record<string, string[]>[];
}

export interface AgentInterface {
  url: string;
  protocol_binding: string;
  protocol_version: string;
}

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

export interface AgentCapabilities {
  streaming: boolean;
  push_notifications: boolean;
  extended_agent_card: boolean;
}

// ── Messages ────────────────────────────────────────────────────────

export interface A2AMessage {
  message_id: string;
  context_id?: string;
  task_id?: string;
  role: "user" | "agent";
  parts: Part[];
  metadata?: Record<string, unknown>;
}

export type Part = TextPart | DataPart | FilePart;

export interface TextPart {
  kind: "text";
  text: string;
}

export interface DataPart {
  kind: "data";
  data: Record<string, unknown>;
  media_type?: string;
}

export interface FilePart {
  kind: "file";
  url?: string;
  raw?: string;
  filename?: string;
  media_type?: string;
}

// ── Tasks ───────────────────────────────────────────────────────────

export type TaskState =
  | "submitted"
  | "working"
  | "completed"
  | "failed"
  | "canceled"
  | "input_required"
  | "rejected";

export interface TaskStatus {
  state: TaskState;
  message?: A2AMessage;
  timestamp: string;
}

export interface A2ATask {
  id: string;
  context_id?: string;
  status: TaskStatus;
  artifacts?: Artifact[];
  history?: A2AMessage[];
  metadata?: Record<string, unknown>;
}

// ── Artifacts ───────────────────────────────────────────────────────

export interface Artifact {
  artifact_id: string;
  parts: Part[];
  metadata?: Record<string, unknown>;
}

// ── Requests / Responses ────────────────────────────────────────────

export interface TaskPushNotificationConfig {
  url: string;
  authentication?: Record<string, unknown>;
}

export interface SendMessageConfiguration {
  accepted_output_modes?: string[];
  history_length?: number;
  return_immediately?: boolean;
  task_push_notification_config?: TaskPushNotificationConfig;
}

export interface SendMessageRequest {
  message: A2AMessage;
  configuration?: SendMessageConfiguration;
}

export type SendMessageResponse = { task: A2ATask } | { message: A2AMessage };

// ── Push Events ─────────────────────────────────────────────────────

export interface TaskStatusUpdateEvent {
  task_id: string;
  status: TaskStatus;
  final: boolean;
}

export interface TaskArtifactUpdateEvent {
  task_id: string;
  artifact: Artifact;
}

// ── JSON-RPC ────────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}
