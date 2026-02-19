export type FollowUpStatus = 'pending' | 'resolved' | 'overdue' | 'nudged';

export interface FollowUp {
  id: string;
  channel: string;
  threadId: string;
  contactId: string | null;
  sentAt: number;
  expectedResponseBy: number | null;
  status: FollowUpStatus;
  /** Canonical field — the recurrence schedule ID linked to this follow-up. */
  reminderScheduleId: string | null;
  /** @deprecated Use {@link reminderScheduleId}. Kept for migration compatibility. */
  reminderCronId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface FollowUpCreateInput {
  channel: string;
  threadId: string;
  contactId?: string | null;
  sentAt?: number;
  expectedResponseBy?: number | null;
  /** Canonical field — the recurrence schedule ID to link. */
  reminderScheduleId?: string | null;
  /** @deprecated Use {@link reminderScheduleId}. Kept for migration compatibility. */
  reminderCronId?: string | null;
}
