/**
 * Email sequencing domain types and input shapes.
 */

// ── Domain Types ────────────────────────────────────────────────────

export type SequenceStatus = "active" | "paused" | "archived";
export type EnrollmentStatus =
  | "active"
  | "paused"
  | "completed"
  | "replied"
  | "cancelled"
  | "failed";

export interface SequenceStep {
  index: number;
  delaySeconds: number; // delay from previous step (0 for first step)
  subjectTemplate: string; // subject line template
  bodyPrompt: string; // prompt for the assistant to generate body
  replyInSameConversation: boolean; // whether to reply in the same conversation as step 1
  requireApproval: boolean; // draft-first, require human approval before send
}

export interface Sequence {
  id: string;
  name: string;
  description: string | null;
  channel: string; // messaging channel (gmail, agentmail, slack)
  steps: SequenceStep[];
  exitOnReply: boolean;
  status: SequenceStatus;
  createdAt: number; // epoch ms
  updatedAt: number;
}

export interface SequenceEnrollment {
  id: string;
  sequenceId: string;
  contactEmail: string;
  contactName: string | null;
  currentStep: number; // index of the next step to send (0-based)
  status: EnrollmentStatus;
  conversationId: string | null; // messaging conversation ID (set after first send)
  nextStepAt: number | null; // epoch ms — when the next step is due
  context: Record<string, unknown> | null; // per-enrollment personalization context
  createdAt: number;
  updatedAt: number;
}

// ── Input Types ─────────────────────────────────────────────────────

export interface CreateSequenceInput {
  name: string;
  description?: string;
  channel: string;
  steps: SequenceStep[];
  exitOnReply?: boolean; // default true
}

export interface UpdateSequenceInput {
  name?: string;
  description?: string;
  steps?: SequenceStep[];
  exitOnReply?: boolean;
  status?: SequenceStatus;
}

export interface EnrollContactInput {
  sequenceId: string;
  contactEmail: string;
  contactName?: string;
  context?: Record<string, unknown>;
}

export interface ListSequencesFilter {
  status?: SequenceStatus;
}

export interface ListEnrollmentsFilter {
  sequenceId?: string;
  status?: EnrollmentStatus;
  contactEmail?: string;
}

export type EnrollmentExitReason =
  | "completed"
  | "replied"
  | "cancelled"
  | "failed";
