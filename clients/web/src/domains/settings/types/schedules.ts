import type {
  SchedulesByIdRunsGetResponse,
  SchedulesGetResponse,
  SchedulesUsagesummaryGetResponse,
} from "@/generated/daemon/types.gen";

export type Schedule = SchedulesGetResponse["schedules"][number] & {
  description: string;
  cadenceDescription: string;
  createdFromConversationId?: string | null;
  createdFromConversationExists?: boolean;
  createdFromConversationArchivedAt?: number | null;
};

export type ScheduleRun = Omit<
  SchedulesByIdRunsGetResponse["runs"][number],
  "conversations"
> & {
  conversationExists?: boolean;
  conversationArchivedAt?: number | null;
  estimatedCostUsd?: number;
  /**
   * Real conversations this firing touched, derived from the usage ledger.
   * The schedule-runs endpoint always sends this, but the field is optional
   * here because runs also arrive from sources that lack it. Those are the
   * system-task run endpoints and daemons that predate the field.
   */
  conversations?: Array<{
    id: string;
    title: string | null;
    exists: boolean;
    archivedAt: number | null;
  }>;
  /**
   * Conversation title shown as the run's primary label when present.
   * Set for memory retrospective runs, where the title ("<source title>
   * (Retrospective)") identifies which conversation was reviewed.
   */
  title?: string | null;
};

export type ScheduleUsageSummaryResponse = SchedulesUsagesummaryGetResponse;
export type ScheduleUsageSummary =
  ScheduleUsageSummaryResponse["summaries"][number];

export type SystemTaskKind = "heartbeat" | "consolidation" | "retrospective";
