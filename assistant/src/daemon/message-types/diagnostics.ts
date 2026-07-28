// Diagnostics, environment, and dictation types.

import type { DictationContext } from "./shared.js";

// === Client → Server ===

export interface DictationRequest {
  type: "dictation_request";
  transcription: string;
  context: DictationContext;
  profileId?: string;
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _DiagnosticsClientMessages = DictationRequest;
