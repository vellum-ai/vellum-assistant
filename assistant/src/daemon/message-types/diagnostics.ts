// Diagnostics, environment, blob probe, and dictation types.

import type { DictationContext } from "./shared.js";

// === Client → Server ===

export interface DiagnosticsExportRequest {
  type: "diagnostics_export_request";
  conversationId: string;
  anchorMessageId?: string; // if omitted, use latest assistant message
}

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

export interface DiagnosticsExportResponse {
  type: "diagnostics_export_response";
  success: boolean;
  filePath?: string; // path to the zip file on success
  error?: string; // error message on failure
}

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

export type _DiagnosticsClientMessages =
  | DiagnosticsExportRequest
  | EnvVarsRequest
  | DictationRequest;

export type _DiagnosticsServerMessages =
  | DiagnosticsExportResponse
  | EnvVarsResponse
  | DictationResponse;
