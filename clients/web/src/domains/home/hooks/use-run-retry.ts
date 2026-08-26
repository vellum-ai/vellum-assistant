import { useMutation } from "@tanstack/react-query";

import { schedulesByIdRunPost } from "@/generated/daemon/sdk.gen";
import { useTranslation } from "@/i18n";
import type { FeedItem } from "@vellumai/assistant-api";
import { toast } from "@vellumai/design-library/components/toast";

/**
 * Retrying a run.
 *
 * A run is only re-runnable through whatever produced it, so there is no
 * generic "run it again" endpoint to call and inventing one would mean a
 * second dispatcher beside the real producers. What exists today is the
 * schedule runner, which covers the runs a person is most likely to want
 * back: a scheduled firing that failed or was interrupted.
 *
 * Anything else falls back to opening the run's conversation, where the work
 * can be asked for again in the one place that has its context. The caller
 * supplies that navigation, since the bell owns closing itself first.
 */
export interface RunRetryOptions {
  onFallbackToConversation: (conversationId: string) => void;
}

/** The schedule a run belongs to, when it belongs to one. */
function readScheduleId(item: FeedItem): string | null {
  const id = item.metadata?.scheduleId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export function useRunRetry(assistantId: string | null) {
  const { t } = useTranslation("home");

  const runSchedule = useMutation({
    mutationFn: async (scheduleId: string) => {
      const { data } = await schedulesByIdRunPost({
        path: { assistant_id: assistantId!, id: scheduleId },
        throwOnError: true,
      });
      return data;
    },
    onSuccess: () => {
      toast.success(t("bellRows.retryStarted"));
    },
    onError: () => {
      toast.error(t("bellRows.retryFailed"));
    },
  });

  const retryRun = async (
    item: FeedItem,
    options: RunRetryOptions,
  ): Promise<void> => {
    const scheduleId = assistantId ? readScheduleId(item) : null;
    if (scheduleId) {
      await runSchedule.mutateAsync(scheduleId).catch(() => {
        // Reported by `onError`; swallowed so a failed retry cannot reject
        // out of an event handler.
      });
      return;
    }
    if (item.conversationId) {
      options.onFallbackToConversation(item.conversationId);
      return;
    }
    toast.error(t("bellRows.retryUnavailable"));
  };

  return { retryRun, isRetrying: runSchedule.isPending };
}
