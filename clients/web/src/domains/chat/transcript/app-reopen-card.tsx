/**
 * The card for an app the assistant first reached during a turn, rendered at
 * the end of that turn's response. A later turn that changes the same app
 * draws nothing: by then the app is in the conversation's assets, which the
 * header pill lists (see `resolve-response-artifacts.ts`).
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
import { usePinnedApps } from "@/hooks/use-pinned-apps";
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
 * entry as the assets pill. A miss there is not an absence: the daemon links an
 * app to the conversation that created, changed, or opened it, but it links on
 * the tool's post-execution hook, so a card rendering before that list is
 * refetched reads a list the app has not landed in yet. The assistant-wide list
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
  const { pinnedAppIds, togglePin } = usePinnedApps(assistantId);

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
      togglePin(appId);
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
