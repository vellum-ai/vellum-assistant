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

export type ScheduleRun = SchedulesByIdRunsGetResponse["runs"][number] & {
  conversationExists?: boolean;
  conversationArchivedAt?: number | null;
  estimatedCostUsd?: number;
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
