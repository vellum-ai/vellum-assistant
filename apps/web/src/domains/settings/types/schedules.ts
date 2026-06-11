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
};

export type ScheduleUsageSummaryResponse = SchedulesUsagesummaryGetResponse;
export type ScheduleUsageSummary =
  ScheduleUsageSummaryResponse["summaries"][number];

export type SystemTaskKind = "heartbeat" | "consolidation";
