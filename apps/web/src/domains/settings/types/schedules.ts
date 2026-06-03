import type {
  SchedulesByIdRunsGetResponse,
  SchedulesGetResponse,
} from "@/generated/daemon/types.gen";

export type Schedule = SchedulesGetResponse["schedules"][number];

export type ScheduleRun = SchedulesByIdRunsGetResponse["runs"][number];

export type SystemTaskKind = "heartbeat" | "consolidation";
