export type HookEventName =
  // Daemon lifecycle
  | 'daemon-start'
  | 'daemon-stop'
  // Session lifecycle
  | 'session-start'
  | 'session-end'
  // LLM call lifecycle
  | 'pre-llm-call'
  | 'post-llm-call'
  // Tool execution lifecycle
  | 'pre-tool-execute'
  | 'post-tool-execute'
  // Permission lifecycle
  | 'permission-request'
  | 'permission-resolve'
  // Message lifecycle
  | 'pre-message'
  | 'post-message'
  // Error
  | 'on-error';

export interface HookManifest {
  name: string;
  description: string;
  version: string;
  events: HookEventName[];
  script: string;
}

export interface HookConfigEntry {
  enabled: boolean;
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
