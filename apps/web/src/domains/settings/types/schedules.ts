import type {
  SchedulesByIdRunsGetResponse,
  SchedulesGetResponse,
} from "@/generated/daemon/types.gen";

export type Schedule = SchedulesGetResponse["schedules"][number] & {
  createdFromConversationId?: string | null;
  createdFromConversationExists?: boolean;
  createdFromConversationArchivedAt?: number | null;
};

export type ScheduleRun = SchedulesByIdRunsGetResponse["runs"][number] & {
  conversationExists?: boolean;
  conversationArchivedAt?: number | null;
  estimatedCostUsd?: number;
};

export type SystemTaskKind = "heartbeat" | "consolidation";
