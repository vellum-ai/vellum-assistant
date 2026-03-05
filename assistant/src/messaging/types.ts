export interface ThreadMessage {
  id: string;
  sender: string;
  body: string;
  timestamp: number; // epoch ms
  channel: string; // email, slack, whatsapp, etc.
  metadata?: Record<string, unknown>;
}

export interface ThreadSummary {
  summary: string;
  participants: Array<{ name: string; role?: string }>;
  openQuestions: string[];
  lastAction: string;
  sentiment: "positive" | "neutral" | "negative" | "mixed";
  messageCount: number;
}
