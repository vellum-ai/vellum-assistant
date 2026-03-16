export type FollowUpStatus = "pending" | "resolved" | "overdue" | "nudged";

export interface FollowUp {
  id: string;
  channel: string;
  conversationId: string;
  contactId: string | null;
  sentAt: number;
  expectedResponseBy: number | null;
  status: FollowUpStatus;
  reminderScheduleId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface FollowUpCreateInput {
  channel: string;
  conversationId: string;
  contactId?: string | null;
  sentAt?: number;
  expectedResponseBy?: number | null;
  reminderScheduleId?: string | null;
}
