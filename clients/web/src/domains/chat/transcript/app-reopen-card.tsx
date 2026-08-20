/**
 * The card for an app the assistant created or changed during a turn, rendered
 * at the end of that turn's response.
 *
 * The app twin of `DocumentReopenLink`, and it exists for the same reason: the
 * daemon emits a `dynamic_page` preview where `app_create` ran, which put a
 * pointer card mid-transcript, split the "Earlier activity" run around it, and
 * doubled up as soon as the same response opened the app again. The transcript
 * drops that surface (see `response-artifacts.ts`) and closes the response with
 * this instead.
 *
 * Name, description, and icon come from the apps query rather than the tool
 * result or the surface's `preview` payload, so the card reads the same
 * identity the assets pill and the Library show, including after a rename. It
 * waits for that query and stays away from an app no resolved list carries, so
 * it never offers to open something that has been deleted.
 */

import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { AppCard } from "@/components/app-card";
import { appsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { usePinnedAppsStore } from "@/stores/pinned-apps-store";
import type { AppSummary } from "@/types/app-types";
import { getCachedAppHtml } from "@/utils/app-html-cache";
import type { AppsGetResponse } from "@/generated/daemon/types.gen";

/**
 * `appId` within one apps response: `null` when the response does not carry
 * it, otherwise its summary.
 */
function selectApp(
  response: AppsGetResponse,
  appId: string,
): AppSummary | null {
  return response.apps.find((app) => app.id === appId) ?? null;
}

/**
 * The app's summary in one apps list: `undefined` until that list resolves and
 * `null` once a resolved list does not carry it.
 *
 * With a conversation the key matches the assets pill's, so both read one cache
 * entry and one invalidation refreshes both. Without one the key drops the
 * filter and reads the assistant-wide list, which no pill shares.
 */
function useAppSummary(
  appId: string,
  assistantId: string | null | undefined,
  conversationId: string | null | undefined,
  enabled: boolean,
): AppSummary | null | undefined {
  const { data } = useQuery({
    ...appsGetOptions({
      path: { assistant_id: assistantId ?? "" },
      ...(conversationId ? { query: { conversationId } } : {}),
    }),
    enabled,
    select: (response) => selectApp(response, appId),
  });
  return data;
}

/**
 * The summary to render for `appId`: `undefined` while it is still being
 * resolved, `null` once no list carries the app.
 *
 * The conversation-scoped list is asked first so the card reads the same cache
 * entry as the assets pill. A miss there is not an absence: the assistant can
 * edit any app it can reach, and an edit does not link the app to the
 * conversation it was made from, so an app reached from an older conversation
 * is missing from this one's list while still existing. The assistant-wide list
 * settles that, and only a miss in both hides the card.
 */
function useAppDisplaySummary(
  appId: string,
  assistantId?: string | null,
  conversationId?: string | null,
): AppSummary | null | undefined {
  const hasAssistant = Boolean(assistantId);
  const scoped = useAppSummary(
    appId,
    assistantId,
    conversationId,
    hasAssistant,
  );
  const assistantWide = useAppSummary(
    appId,
    assistantId,
    null,
    hasAssistant && Boolean(conversationId) && scoped === null,
  );

  if (conversationId && scoped === null) {
    return assistantWide;
  }
  return scoped;
}

export interface AppReopenCardProps {
  /** Id of the app the turn created or changed. */
  appId: string;
  /** Assistant the apps query reads through. */
  assistantId?: string | null;
  /** Conversation the app belongs to. */
  conversationId?: string | null;
  onOpenApp: (appId: string) => void;
}

export function AppReopenCard({
  appId,
  assistantId,
  conversationId,
  onOpenApp,
}: AppReopenCardProps) {
  const summary = useAppDisplaySummary(appId, assistantId, conversationId);
  const pinnedAppIds = usePinnedAppsStore.use.pinnedAppIds();
  const togglePin = usePinnedAppsStore.use.togglePin();

  // The thumbnail is a live mini-iframe of the app, loaded lazily when the card
  // scrolls into view. Same cache the inline preview read, so a card that
  // replaces a preview in the same session paints from a warm entry.
  const loadHtml = useMemo(
    () =>
      assistantId ? () => getCachedAppHtml(assistantId, appId) : undefined,
    [assistantId, appId],
  );

  const handlePin = useCallback(() => {
    if (summary) {
      togglePin({ id: appId, name: summary.name, icon: summary.icon });
    }
  }, [togglePin, appId, summary]);

  if (summary == null) {
    return null;
  }

  return (
    <div className="max-w-sm" data-testid="app-reopen-card">
      <AppCard
        name={summary.name}
        description={summary.description}
        icon={summary.icon}
        loadHtml={loadHtml}
        isPinned={pinnedAppIds.has(appId)}
        onOpen={() => onOpenApp(appId)}
        onPin={handlePin}
      />
    </div>
  );
}
