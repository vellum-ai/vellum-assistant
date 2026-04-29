export type Tone = "grounded" | "warm" | "energetic" | "poetic";

export interface OnboardingContext {
  tools: string[];
  tasks: string[];
  tone: string;
  userName?: string;
  assistantName?: string;
}
