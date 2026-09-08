import { schedulesGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
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
    cadenceDescription?: string;
    description?: string;
  };
  const description = raw.description ?? "";
  return {
    ...schedule,
    description,
    cadenceDescription: raw.cadenceDescription ?? description,
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

/**
 * TanStack Query options for the schedules list. The single definition of the
 * list's query key + staleTime, so every consumer (the Schedules page data
 * hook, the notification bell's "View schedule" link validation) reads one
 * shared cache entry instead of hand-copying the key.
 *
 * Lives here rather than in `domains/settings/api/schedules.ts` because
 * consumers span domains (settings, schedules, home) and a domain may not
 * import a peer's internals. The settings module re-exports it for its own
 * callers.
 */
export function schedulesListQueryOptions(assistantId: string | undefined) {
  return {
    queryKey: schedulesGetQueryKey({
      path: { assistant_id: assistantId ?? "" },
    }),
    queryFn: () =>
      assistantId
        ? fetchSchedules(assistantId)
        : Promise.resolve<AssistantSchedule[]>([]),
    staleTime: 10_000,
  };
}

/**
 * Whether a schedule still has a firing ahead of it. `fired` and `cancelled`
 * are the two terminal states a one-shot lands in; everything else (including
 * a disabled row, which fires again once re-enabled) can still run.
 *
 * This mirrors the rule the daemon applies when re-pinning every schedule onto
 * one profile, so the count offered here is the count that comes back.
 *
 * Lives beside the query rather than in a domain, for the same reason the
 * query does: settings, schedules, and home all read it.
 */
export function canScheduleStillRun(
  schedule: Pick<AssistantSchedule, "status">,
): boolean {
  return schedule.status !== "fired" && schedule.status !== "cancelled";
}

/**
 * Whether a schedule is one the user would recognise as theirs: something they
 * set up, that has not run itself out.
 *
 * Two of the rows the list returns are not that. A plugin-declared row carries
 * a `sourceKey` of the form `plugin:<plugin>/<name>` (the field is null for
 * user-created rows) and arrives with the plugin rather than by anyone's
 * choice, so it is no evidence the user has ever made a schedule. A `fired` or
 * `cancelled` row is spent and will never produce anything again.
 *
 * The three system tasks (heartbeat, memory consolidation, memory
 * retrospective) need no exclusion here. Each is its own subsystem with its
 * own timer and its own config endpoints, and none of them is a row in this
 * list, which is why the Schedules page renders them from a separate source.
 * Deferred "remind me later" wakes need none either: the list endpoint drops
 * them unless `include_all` is asked for, and this client never asks.
 */
export function isLiveUserSchedule(
  schedule: Pick<AssistantSchedule, "status" | "sourceKey">,
): boolean {
  return schedule.sourceKey == null && canScheduleStillRun(schedule);
}
