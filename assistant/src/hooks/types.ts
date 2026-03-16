export type HookEventName =
  // Daemon lifecycle
  | "daemon-start"
  | "daemon-stop"
  // Conversation lifecycle
  | "conversation-start"
  | "conversation-end"
  // LLM call lifecycle
  | "pre-llm-call"
  | "post-llm-call"
  // Tool execution lifecycle
  | "pre-tool-execute"
  | "post-tool-execute"
  // Permission lifecycle
  | "permission-request"
  | "permission-resolve"
  // Message lifecycle
  | "pre-message"
  | "post-message"
  // Error
  | "on-error";

export interface HookSettingsSchemaEntry {
  type: string;
  default?: unknown;
  description?: string;
}

export interface HookManifest {
  name: string;
  description?: string;
  version?: string;
  events: HookEventName[];
  script: string;
  /** When true, non-zero exit from this hook cancels pre-* actions. Default false. */
  blocking?: boolean;
  /** Schema for per-hook settings with defaults and descriptions. */
  settingsSchema?: Record<string, HookSettingsSchemaEntry>;
}

export interface HookConfigEntry {
  enabled: boolean;
  /** Per-hook user settings that override manifest defaults. */
  settings?: Record<string, unknown>;
}

export interface HookConfig {
  version: number;
  hooks: Record<string, HookConfigEntry>;
}

export interface DiscoveredHook {
  name: string;
  /** Absolute path to hook directory */
  dir: string;
  manifest: HookManifest;
  /** Absolute path to the script */
  scriptPath: string;
  enabled: boolean;
}

export interface HookEventData {
  event: HookEventName;
  [key: string]: unknown;
}

export interface HookTriggerResult {
  /** True if a blocking hook rejected the action (non-zero exit). */
  blocked: boolean;
  /** Name of the hook that blocked, if any. */
  blockedBy?: string;
}
