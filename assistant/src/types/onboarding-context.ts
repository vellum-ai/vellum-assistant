export interface OnboardingContext {
  tools: string[];
  tasks: string[];
  tone: string;
  userName?: string;
  assistantName?: string;
  priorAssistants?: string[];
  googleConnected?: boolean;
  googleScopes?: string[];
  cohort?: string;
  websiteUrl?: string;
  contentSourceUrl?: string;
}
