import type { PluginListenerHandle } from "@capacitor/core";
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { assistantsListOptions } from "@/generated/api/@tanstack/react-query.gen.js";
import { subscribeChatEvents } from "@/domains/chat/lib/api.js";
import type { ChatEventStream } from "@/domains/chat/lib/api.js";
import { isNativePlatform } from "@/runtime/native-auth.js";
import { createSyncTagRegistry } from "@/lib/sync/tag-registry.js";
import {
  invalidateAssistantConfigQueries,
  invalidateAssistantSchedulesQueries,
  invalidateAssistantSoundsQueries,
} from "@/lib/sync/query-tags.js";
import { SYNC_TAGS } from "@/lib/sync/types.js";

const SETTINGS_STREAM_RETRY_DELAY_MS = 30_000;

/**
 * Subscribes to the assistant event stream while on the settings pages
 * and invalidates TanStack Query caches when relevant sync tags arrive.
 * On native platforms also re-syncs when the app resumes from background.
 */
export function useSettingsSync(
  streamRetryDelayMs = SETTINGS_STREAM_RETRY_DELAY_MS,
): void {
  const queryClient = useQueryClient();
  const { data: assistantList } = useQuery(assistantsListOptions());
  const assistantId = assistantList?.results?.[0]?.id ?? null;

  useEffect(() => {
    if (!assistantId) return;

    const activeAssistantId = assistantId;
    let cancelled = false;
    const registry = createSyncTagRegistry();
    const registrations = [
      registry.register(SYNC_TAGS.assistantConfig, () => {
        invalidateAssistantConfigQueries(queryClient, activeAssistantId);
      }),
      registry.register(SYNC_TAGS.assistantSounds, () => {
        invalidateAssistantSoundsQueries(queryClient, activeAssistantId);
      }),
      registry.register(SYNC_TAGS.assistantSchedules, () => {
        invalidateAssistantSchedulesQueries(queryClient, activeAssistantId);
      }),
    ];
    let lastResumeRefreshAt = 0;
    const RESUME_DEDUP_WINDOW_MS = 1000;
    let stream: ChatEventStream | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const clearRetryTimer = () => {
      if (!retryTimer) return;
      clearTimeout(retryTimer);
      retryTimer = null;
    };

    const refreshOnResume = () => {
      if (cancelled) return;
      const now = Date.now();
      if (now - lastResumeRefreshAt < RESUME_DEDUP_WINDOW_MS) return;
      lastResumeRefreshAt = now;
      void registry.dispatchReconnect();
      if (!stream) {
        restartStream({ refresh: false });
      }
    };

    const scheduleStreamRestart = () => {
      if (cancelled || retryTimer) return;
      stream?.cancel();
      stream = null;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        restartStream();
      }, streamRetryDelayMs);
    };

    function restartStream({ refresh = true }: { refresh?: boolean } = {}) {
      if (cancelled) return;
      clearRetryTimer();
      if (refresh) {
        void registry.dispatchReconnect();
      }
      openStream();
    }

    function openStream() {
      if (cancelled) return;
      stream?.cancel();
      stream = subscribeChatEvents(
        activeAssistantId,
        null,
        (event) => {
          if (event.type === "sync_changed") {
            void registry.dispatch(event);
          }
        },
        scheduleStreamRestart,
        {
          onReconnect: async () => {
            if (cancelled) return;
            await registry.dispatchReconnect();
          },
        },
      );
    }

    openStream();
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        refreshOnResume();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    let appStateHandle: PluginListenerHandle | null = null;
    let appStateCancelled = false;
    if (isNativePlatform()) {
      import("@capacitor/app")
        .then(({ App }) =>
          App.addListener("appStateChange", ({ isActive }) => {
            if (isActive) {
              refreshOnResume();
            }
          }),
        )
        .then((registered) => {
          if (appStateCancelled) {
            void registered.remove();
            return;
          }
          appStateHandle = registered;
        })
        .catch(() => {
          // Browser visibility still covers non-native and plugin failure paths.
        });
    }

    return () => {
      cancelled = true;
      clearRetryTimer();
      stream?.cancel();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      appStateCancelled = true;
      void appStateHandle?.remove();
      for (const registration of registrations) {
        registration.dispose();
      }
      registry.clear();
    };
  }, [assistantId, queryClient, streamRetryDelayMs]);
}
