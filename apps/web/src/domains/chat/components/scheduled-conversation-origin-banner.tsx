import { useQuery } from "@tanstack/react-query";
import { CalendarClock, MessageSquare, Settings } from "lucide-react";
import { Link } from "react-router";

import { Button } from "@vellumai/design-library/components/button";

import { assistantSchedulesQueryKey } from "@/lib/sync/query-tags";
import type { Conversation } from "@/types/conversation-types";
import { isScheduledConversation } from "@/utils/conversation-predicates";
import { routes } from "@/utils/routes";
import {
  fetchSchedules,
  getOpenableScheduleSourceConversationId,
} from "@/utils/schedules";

interface ScheduledConversationOriginBannerProps {
  assistantId: string | null | undefined;
  conversation: Conversation | null;
}

export function ScheduledConversationOriginBanner({
  assistantId,
  conversation,
}: ScheduledConversationOriginBannerProps) {
  const scheduleJobId = conversation?.scheduleJobId ?? null;
  const shouldRender =
    conversation != null &&
    isScheduledConversation(conversation) &&
    scheduleJobId != null;

  const { data: schedules, isFetched } = useQuery({
    queryKey: assistantSchedulesQueryKey(assistantId),
    queryFn: () => fetchSchedules(assistantId!),
    enabled: shouldRender && !!assistantId,
    staleTime: 30_000,
  });

  if (!shouldRender) return null;

  const schedule = schedules?.find((candidate) => candidate.id === scheduleJobId);
  const hasResolvedMissingSchedule = isFetched && !schedule;
  const title =
    schedule?.name?.trim() ||
    (hasResolvedMissingSchedule
      ? "Schedule details unavailable"
      : "Scheduled automation");
  const prompt = schedule?.message?.trim() || null;
  const sourceConversationId =
    schedule ? getOpenableScheduleSourceConversationId(schedule) : null;
  const showScheduleLink = !hasResolvedMissingSchedule;

  return (
    <div className="px-3 pt-4 pb-2 sm:px-6">
      <section
        aria-label="Scheduled conversation context"
        className="mx-auto flex max-w-[var(--chat-max-width)] flex-col gap-3 rounded-lg border border-[var(--border-element)] bg-[var(--surface-lift)] px-3 py-3 text-body-small-default text-[var(--content-default)] sm:flex-row sm:items-start sm:justify-between"
      >
        <div className="flex min-w-0 gap-3">
          <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--surface-active)] text-[var(--content-secondary)]">
            <CalendarClock className="h-4 w-4" aria-hidden="true" />
          </div>
          <div className="min-w-0 space-y-1">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
              <span className="text-label-medium-default text-[var(--content-secondary)]">
                Started by schedule
              </span>
              <span className="min-w-0 truncate text-label-medium-default text-[var(--content-default)]">
                {title}
              </span>
            </div>
            {prompt ? (
              <p className="line-clamp-2 break-words text-[var(--content-secondary)]">
                <span className="text-[var(--content-tertiary)]">Prompt:</span>{" "}
                {prompt}
              </p>
            ) : hasResolvedMissingSchedule ? (
              <p className="text-[var(--content-secondary)]">
                The schedule that started this conversation is no longer available.
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 sm:justify-end">
          {sourceConversationId ? (
            <Button
              asChild
              variant="outlined"
              size="compact"
            >
              <Link to={routes.conversation(sourceConversationId)}>
                <MessageSquare className="h-2.5 w-2.5" aria-hidden="true" />
                Original conversation
              </Link>
            </Button>
          ) : null}
          {showScheduleLink ? (
            <Button
              asChild
              variant="ghost"
              size="compact"
            >
              <Link to={routes.settings.schedule(scheduleJobId)}>
                <Settings className="h-2.5 w-2.5" aria-hidden="true" />
                Schedule
              </Link>
            </Button>
          ) : null}
        </div>
      </section>
    </div>
  );
}
