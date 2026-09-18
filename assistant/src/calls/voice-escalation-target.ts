export type VoiceEscalationProfileSource =
  | "conversation"
  | "turn_override"
  | "pre_model_hook"
  | "call_site";

export interface VoiceEscalationTarget {
  profile: string;
  source: VoiceEscalationProfileSource;
}
