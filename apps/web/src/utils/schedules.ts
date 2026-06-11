import { schedulesGet } from "@/generated/daemon/sdk.gen";
import type { SchedulesGetResponse } from "@/generated/daemon/types.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";

export type AssistantSchedule = SchedulesGetResponse["schedules"][number];

function normalizeSchedule(schedule: AssistantSchedule): AssistantSchedule {
  const raw = schedule as AssistantSchedule & {
    authoredDescription?: string;
    cadenceDescription?: string;
    description?: string;
  };
  const legacyDescription = raw.description ?? "";
  const cadenceDescription = raw.cadenceDescription ?? legacyDescription;
  const authoredDescription =
    raw.authoredDescription ??
    (raw.cadenceDescription === undefined ? "" : legacyDescription);
  return {
    ...schedule,
    description: authoredDescription,
    authoredDescription,
    cadenceDescription,
  };
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
  return (data?.schedules ?? []).map(normalizeSchedule);
}
