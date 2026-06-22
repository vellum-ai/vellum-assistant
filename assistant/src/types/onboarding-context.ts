export interface OnboardingContext {
  tools: string[];
  tasks: string[];
  tone: string;
  userName?: string;
  /** The user's role / occupation, e.g. "Software Engineer". */
  occupation?: string;
  assistantName?: string;
  priorAssistants?: string[];
  googleConnected?: boolean;
  googleScopes?: string[];
  cohort?: string;
  websiteUrl?: string;
  contentSourceUrl?: string;
  /** Filename of the bootstrap template to use (e.g. "BOOTSTRAP-CONTENT-AUTOMATION.md"). When set, replaces generic BOOTSTRAP.md if still pristine. */
  bootstrapTemplate?: string;
  /** Override the first user message content. When set during a wake-up greeting, this replaces the canned greeting. */
  initialMessage?: string;
  /** Skills to eagerly load on first turn (e.g. ["geo-writing", "document-editor"]). Informational — the bootstrap template drives actual loading. */
  skills?: string[];
}
