// Diagnostics, environment, and dictation types.

import type { DictationContext } from "./shared.js";

// === Client → Server ===

export interface EnvVarsRequest {
  type: "env_vars_request";
}

export interface DictationRequest {
  type: "dictation_request";
  transcription: string;
  context: DictationContext;
  profileId?: string;
}

// === Server → Client ===

export interface EnvVarsResponse {
  type: "env_vars_response";
  vars: Record<string, string>;
}

export interface DictationResponse {
  type: "dictation_response";
  text: string;
  mode: "dictation" | "command" | "action";
  actionPlan?: string;
  resolvedProfileId?: string;
  profileSource?: "request" | "app_mapping" | "default" | "fallback";
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _DiagnosticsClientMessages = EnvVarsRequest | DictationRequest;

export type _DiagnosticsServerMessages = EnvVarsResponse | DictationResponse;
