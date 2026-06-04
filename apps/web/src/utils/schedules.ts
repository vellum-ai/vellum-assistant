import { schedulesGet } from "@/generated/daemon/sdk.gen";
import type { SchedulesGetResponse } from "@/generated/daemon/types.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";

export type AssistantSchedule = SchedulesGetResponse["schedules"][number];

export interface ScheduleSourceConversationFields {
  createdFromConversationId?: string | null;
  createdFromConversationExists?: boolean;
  createdFromConversationArchivedAt?: number | null;
}

export function canOpenScheduleSourceConversation(
  schedule: ScheduleSourceConversationFields,
): boolean {
  return (
    !!schedule.createdFromConversationId &&
    schedule.createdFromConversationExists === true &&
    schedule.createdFromConversationArchivedAt == null
  );
}

export function getOpenableScheduleSourceConversationId(
  schedule: ScheduleSourceConversationFields,
): string | null {
  return canOpenScheduleSourceConversation(schedule)
    ? (schedule.createdFromConversationId ?? null)
    : null;
}

export async function fetchSchedules(
  assistantId: string,
): Promise<AssistantSchedule[]> {
  const { data, error, response } = await schedulesGet({
    path: { assistant_id: assistantId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load schedules.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to load schedules."),
    );
  }
  return data?.schedules ?? [];
}
