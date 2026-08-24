import { useCallback, useEffect, useRef } from "react";

import {
  useCanQueryDaemon,
  useUnreadConversationCount,
} from "@/hooks/conversation-queries";
import { useTranslation } from "@/i18n";
import {
  clearWidgetSnapshot,
  isWidgetSnapshotSyncAvailable,
  readWidgetSnapshotAssistantId,
  retryPendingWidgetSnapshotClear,
  syncWidgetSnapshot,
  WIDGET_SNAPSHOT_SCHEMA_VERSION,
  type WidgetSnapshotConversation,
  type WidgetSnapshotPayload,
} from "@/runtime/widget-snapshot";
import { useConversationStore } from "@/stores/conversation-store";
import type {
  Conversation,
  ConversationGroup,
} from "@/types/conversation-types";
import { activeConversationsByRecency } from "@/utils/conversation-order";

/**
 * How many conversations the Home Screen widgets get. The Catch Up medium
 * widget draws three rows and nothing else reads the list, so a longer
 * payload would only cost bridge traffic and App Group space.
 */
const MAX_SNAPSHOT_CONVERSATIONS = 3;

/**
 * How often a live session re-sends its unchanged snapshot, purely to move
 * `generatedAt` forward.
 *
 * The widget extension cannot ask whether the app is running, so it ages the
 * snapshot out on its own: past `SnapshotProvider.staleAfter` (30 minutes, in
 * `SnapshotTimeline.swift`) it drops the live claims, hiding the Status counts
 * and the Quick Actions unread chip. Nothing shares that constant across the
 * bridge, so this is the coupling: any change to one has to be weighed against
 * the other. Dedup is on content alone, so an app left open on unchanged data
 * writes nothing and would cross that line while sitting in the foreground on
 * data it has been refetching all along. Half the native window is the
 * interval, so the snapshot stays fresh even when a heartbeat is lost, and one
 * bridge call per 15 minutes is far below what a single re-render costs.
 */
export const WIDGET_SNAPSHOT_HEARTBEAT_MS = 15 * 60 * 1000;

/** A snapshot before it is stamped, which is also the dedup key's shape. */
type SnapshotContent = Omit<WidgetSnapshotPayload, "generatedAt">;

/**
 * Mirror the conversation list into the iOS shell's `WidgetSnapshot` plugin
 * so the Home Screen widgets can draw unread and in-progress counts and the
 * three most recent chats. No-ops everywhere but Capacitor iOS.
 *
 * Mount once at a layout that already holds the conversation list (currently
 * `ChatLayout`, beside `useNativeRecentChatsSync`, its Shortcuts sibling).
 *
 * The unread count prefers the assistant's server-side count and falls back
 * to the loaded rows, the same resolution the Electron Dock badge uses, so
 * the two surfaces never disagree about the number. The count query is gated
 * on the platform and on the assistant being active: `ChatLayout` mounts
 * before the assistant finishes starting, and querying a starting assistant
 * spends the retry budget on a request that cannot succeed.
 *
 * In-progress rows come from two sources that have to be unioned, exactly as
 * the sidebar row does it: the server-seeded `isProcessing` flag, and the
 * client's own in-flight turns tracked in `processingConversationIds`. Either
 * alone under-reports, since a turn started in this session may not be
 * reflected in the list payload yet and a turn started elsewhere is only in
 * the payload.
 *
 * Syncs are deduped on the serialized snapshot with `generatedAt` excluded.
 * Including it would make every render a fresh payload and the dedup dead,
 * so the shell would take bridge traffic and a widget timeline reload on
 * every re-render of the layout.
 *
 * That leaves the timestamp to a heartbeat
 * ({@link WIDGET_SNAPSHOT_HEARTBEAT_MS}), because the widget reads it as
 * freshness rather than as a change marker: an app left open on unchanged data
 * would otherwise let its snapshot age past the native stale window and lose
 * the live counts, while the app it came from is in the foreground refetching
 * that same data. The heartbeat sends the latest DESIRED content, meaning what
 * this session currently wants the App Group to hold, rather than what last
 * landed there. The two are the same payload in the ordinary case, and the tick
 * is then purely a fresh `generatedAt`. They diverge when a data sync rejects or
 * times out: the last landed payload is outdated, and re-stamping it would age
 * outdated conversations and counts into reading as current, every 15 minutes
 * for as long as nothing re-renders to retry the newer one. Sending the desired
 * content instead makes the tick double as that retry, which strictly widens the
 * retry-on-the-next-effect-run below. It goes through the same send path either
 * way, so it shares the attempt counter, the in-flight dedup and the landed
 * bookkeeping: one that fails leaves every ref as it found it, and one that is
 * overtaken by a real data sync cannot arm the dedup key behind it.
 *
 * It is armed from the resolved inputs rather than from the moment a write
 * lands, and asks at each tick whether there is anything to send. A tick with
 * nothing desired does nothing (an empty or signed-out Home Screen has no
 * freshness to keep and nothing to retry), and re-arming on every landed write
 * would make the timer's lifetime depend on render state the effect would then
 * have to carry. Unresolved inputs disarm it: the heartbeat asserts the data is
 * current, which is exactly what a pending or errored query cannot say, so a
 * preserved snapshot is left to age out on the native side instead.
 *
 * Resolution alone cannot carry that claim, because a query that succeeded and
 * then lost its source stays resolved: TanStack Query keeps serving the cached
 * rows with neither pending nor error set. An assistant that goes inactive, or
 * a pod that stops serving, would leave the heartbeat re-stamping data nothing
 * is refetching, which is exactly when the native staleness degradation should
 * be taking the live claims down. So the heartbeat also requires the
 * preconditions those queries are gated on, meaning they would fetch if asked:
 * the assistant gate the caller passes them, and the daemon gate they apply
 * inside their own hooks. When either closes, the ticks stop and the snapshot
 * ages out natively as designed. Only the freshness re-stamp is gated. Nothing
 * fetches behind a closed gate, so the cache stops changing on its own, and a
 * payload that does change is worth writing whatever the gate says.
 *
 * The dedup key describes what the App Group is known to HOLD, so it is armed
 * from the resolution of the bridge call rather than from the render that fired
 * it: the bridge can reject (an older shell) or time out, and a key armed for a
 * write that never landed would suppress every retry until the conversation
 * data itself changed, stranding a stale snapshot on the Home Screen. Nothing
 * guarantees such a change arrives, which is the other half of why the
 * heartbeat carries the desired content: a failed write is retried on the next
 * tick even when the query layer hands back structurally identical results
 * forever. The payload still on the bridge is deduped against separately, so a
 * re-render inside that window does not send it twice.
 *
 * `inputsResolved` must be false until BOTH queries behind the snapshot, the
 * conversation list and the conversation groups, have actually SUCCEEDED.
 * Each serves an `[]` fallback while pending (loading, or gated on the
 * assistant/pod) AND while in a terminal error state, and the caller must
 * exclude both states for both queries (`!isPending && !isError`): a bare
 * `!isPending` lets the error case through. Without the guard, every launch
 * would blank the widgets before the first load, and a launch that never
 * loads (offline, assistant never ready, pod waking into a 503 error) would
 * blank them for as long as it lasted, despite a last-known-good snapshot
 * sitting in the App Group. The groups query is in the guard because the rows
 * carry group names as subtitles, so a list that resolves ahead of the groups
 * would replace a good snapshot with one whose subtitles are all missing, and
 * a terminal groups error would leave it that way. An empty list from
 * *successful* queries does sync: genuinely having no conversations should
 * empty the widgets.
 *
 * That preservation is scoped to ONE assistant. A snapshot describes the
 * assistant it was built from, so an in-SPA switch
 * (`switchToResolvedAssistant`) invalidates it outright: the new assistant's
 * list starts unresolved, and preserving across the switch would leave the
 * previous assistant's titles, counts and conversation targets on a Home
 * Screen that never reloads on its own, indefinitely if the new assistant
 * never comes up. So the hook tracks which assistant produced the snapshot it
 * last wrote and drops it as soon as that id changes.
 *
 * An in-memory ref alone cannot answer that on a cold launch: the App Group
 * snapshot outlives the page, so a run that starts on a different assistant
 * begins with the ref null and would preserve another assistant's titles for
 * as long as its own list stayed unresolved. The producer id is therefore
 * also persisted next to the snapshot (`readWidgetSnapshotAssistantId`), and
 * read once per launch to seed that ref. A launch with no recorded producer,
 * or one recorded for the assistant now active, is not a switch and keeps the
 * preservation.
 *
 * The read seeds the ref rather than a per-render local because a launch on
 * the recorded producer may never resolve its own list, and so may never write
 * the ref itself. Held only for the render that read it, a later switch away
 * would find no known owner and leave that producer's titles on the Home
 * Screen indefinitely.
 *
 * A clear owed by a previous session (its sign-out or origin swap reached a
 * bridge that rejected or never answered) is finished on mount, before this
 * session writes anything of its own. `syncWidgetSnapshot` awaits the same
 * retry, so the ordering holds however the two are scheduled; the mount call is
 * what covers the launch that reaches no sync at all, where a list that never
 * resolves would otherwise leave the departed snapshot up for the whole run.
 *
 * The fallback for a conversation with no title is serialized into the App
 * Group and drawn verbatim by the widget, so it comes from the catalog rather
 * than a literal. It is read through the reactive `useTranslation` binding,
 * not the bound `t`, because the string outlives the render that produced it:
 * a language switch has to reach a Home Screen that never reloads on its own.
 * Resolving it inside the effect is what makes that work, since the new
 * language changes the serialized payload and so the dedup key too.
 */
export function useNativeWidgetSnapshotSync(
  assistantId: string | null,
  conversations: Conversation[],
  conversationGroups: ConversationGroup[],
  isAssistantActive: boolean,
  inputsResolved: boolean,
): void {
  // What the App Group is known to hold, so an unchanged payload costs no
  // bridge traffic. Armed only once a write has actually landed: a rejected or
  // timed-out call changed nothing, and a key armed for it would suppress every
  // retry until the conversation data itself changed.
  const lastPayloadRef = useRef<string | null>(null);
  // The newest content this session wants the App Group to hold, landed or not,
  // which is what the heartbeat sends. Written on every resolved run, so a tick
  // after a write that never landed retries the current data rather than
  // re-stamping the outdated payload that is still on the Home Screen. Dropped
  // wherever the snapshot stops describing the active assistant.
  const desiredContentRef = useRef<SnapshotContent | null>(null);
  // The payload currently on the bridge, if a call has not settled yet. Dedup
  // runs against it as well, so a re-render inside the bridge's window does not
  // send the same payload twice; it is dropped as the call settles, which is
  // what lets the next effect run retry a write that never landed.
  const inFlightPayloadRef = useRef<string | null>(null);
  // Monotonic id for the outstanding call. Only the latest attempt records what
  // it wrote, so a slow call settling after a newer one (or after an assistant
  // switch) cannot arm the dedup key with a payload the App Group no longer
  // holds.
  const syncAttemptRef = useRef(0);
  // The assistant the snapshot in the App Group was built from: whatever this
  // hook last sent, or the producer read back from storage on a cold launch.
  // Null while no producer is known, which is what keeps a launch from reading
  // as a switch.
  const syncedAssistantIdRef = useRef<string | null>(null);
  // Whether the persisted producer id has been consulted. It only answers for
  // a snapshot this page lifetime did not write, so one read per launch is
  // enough and the ref is authoritative from then on.
  const readPersistedOwnerRef = useRef(false);
  const { t } = useTranslation("chat");
  const processingConversationIds =
    useConversationStore.use.processingConversationIds();

  const unreadCount = useUnreadConversationCount(
    assistantId,
    conversations,
    isWidgetSnapshotSyncAvailable() && isAssistantActive,
  );
  // Whether the queries behind the snapshot would fetch if asked: the same two
  // gates they run under, the caller's assistant gate and the daemon
  // preconditions the query hooks apply for themselves. What tells a heartbeat
  // that resolved data is still being kept current rather than merely cached.
  const canQueryDaemon = useCanQueryDaemon(assistantId);
  const inputsAreLive = isAssistantActive && canQueryDaemon;

  // The one way to the bridge, shared by data syncs and the heartbeat so a
  // heartbeat cannot corrupt the bookkeeping a data sync depends on.
  const sendSnapshot = useCallback(
    (content: SnapshotContent, ownerId: string | null): void => {
      const serialized = JSON.stringify(content);
      // The producer is recorded as the call is fired rather than when it
      // lands. A write already on the bridge can land at any moment, so a
      // switch that happens in between has to see this assistant as an owner.
      // Naming one too eagerly costs at most an idempotent clear; naming one
      // too late leaves another assistant's titles on a Home Screen that never
      // reloads.
      syncedAssistantIdRef.current = ownerId;
      inFlightPayloadRef.current = serialized;
      const attempt = (syncAttemptRef.current += 1);
      void syncWidgetSnapshot(
        {
          ...content,
          generatedAt: new Date().toISOString(),
        },
        ownerId,
      ).then((landed) => {
        if (attempt !== syncAttemptRef.current) {
          return;
        }
        inFlightPayloadRef.current = null;
        if (!landed) {
          return;
        }
        lastPayloadRef.current = serialized;
      });
    },
    [],
  );

  // A clear a previous session could not finish (its bridge rejected or timed
  // out on the way out of a sign-out or an origin swap) is persisted as an
  // obligation, so this launch honors it. `syncWidgetSnapshot` awaits the same
  // retry, which is what orders it ahead of anything this session writes; the
  // mount call is for the launch that never reaches a sync at all, where a list
  // that stays unresolved would otherwise leave the departed snapshot up.
  useEffect(() => {
    if (!isWidgetSnapshotSyncAvailable()) {
      return;
    }
    void retryPendingWidgetSnapshotClear();
  }, []);

  useEffect(() => {
    if (!isWidgetSnapshotSyncAvailable()) {
      return;
    }

    // Checked ahead of the `inputsResolved` guard, which would otherwise hold
    // the previous assistant's snapshot for the whole time the new one takes
    // to resolve. Dropping the dedup key too, so the new assistant's first
    // resolved list always reaches the bridge even when it happens to
    // serialize identically to what the previous one last wrote.
    //
    // On a cold launch the ref is null while a snapshot from a previous run
    // may still be on the Home Screen, so its producer comes from storage and
    // seeds the ref. Deferred until the active assistant is known, so a launch
    // that has not resolved one yet is never mistaken for a switch. Seeding
    // rather than reading into a local is what keeps the owner detectable when
    // the launch assistant's own list never resolves and never writes the ref.
    if (!readPersistedOwnerRef.current && assistantId !== null) {
      readPersistedOwnerRef.current = true;
      syncedAssistantIdRef.current = readWidgetSnapshotAssistantId();
    }
    const snapshotOwnerId = syncedAssistantIdRef.current;
    const switchedAssistant =
      snapshotOwnerId !== null && snapshotOwnerId !== assistantId;
    if (switchedAssistant) {
      syncedAssistantIdRef.current = null;
      lastPayloadRef.current = null;
      // A heartbeat the platform coalesced past this run must never put the
      // previous assistant's rows back on a Home Screen that was just cleared.
      desiredContentRef.current = null;
      inFlightPayloadRef.current = null;
      // Retires any call still on the bridge for the previous assistant, so it
      // cannot arm the dedup key after the clear below.
      syncAttemptRef.current += 1;
    }

    if (!inputsResolved) {
      // Only on a switch: a pending or errored query for the SAME assistant
      // still keeps its last-known-good snapshot.
      if (switchedAssistant) {
        void clearWidgetSnapshot();
      }
      return;
    }

    const isProcessing = (conversation: Conversation): boolean =>
      conversation.isProcessing === true ||
      processingConversationIds.has(conversation.conversationId);

    const groupNames = new Map(
      conversationGroups.map((group) => [group.id, group.name]),
    );
    const active = activeConversationsByRecency(conversations);
    const inProgressCount = active.filter(isProcessing).length;
    const rows: WidgetSnapshotConversation[] = active
      .slice(0, MAX_SNAPSHOT_CONVERSATIONS)
      .map((conversation) => ({
        id: conversation.conversationId,
        title: conversation.title ?? t("useNativeWidgetSnapshotSync.untitled"),
        subtitle:
          conversation.groupId === undefined
            ? undefined
            : groupNames.get(conversation.groupId),
        hasUnseen: conversation.hasUnseenLatestAssistantMessage === true,
        isProcessing: isProcessing(conversation),
      }));

    // Built without `generatedAt` so the serialized form is the dedup key.
    const content: SnapshotContent = {
      schemaVersion: WIDGET_SNAPSHOT_SCHEMA_VERSION,
      unreadCount,
      inProgressCount,
      conversations: rows,
    };
    const serialized = JSON.stringify(content);
    // Recorded whether or not this run sends it, since it describes what the
    // App Group should hold rather than what reached it.
    desiredContentRef.current = content;
    if (
      serialized === lastPayloadRef.current ||
      serialized === inFlightPayloadRef.current
    ) {
      return;
    }
    sendSnapshot(content, assistantId);
  }, [
    assistantId,
    conversations,
    conversationGroups,
    processingConversationIds,
    unreadCount,
    inputsResolved,
    sendSnapshot,
    t,
  ]);

  // Keep `generatedAt` moving while this session is live and its data is
  // verified current, so the widgets never call an open app's snapshot stale,
  // and carry the newest content so a write that never landed is retried
  // rather than left behind an outdated one that keeps being re-stamped.
  //
  // Current means both resolved and still being refetched: cached rows from an
  // assistant that stopped serving are resolved forever, and re-stamping them
  // would defeat the native staleness degradation exactly when it applies.
  useEffect(() => {
    if (!isWidgetSnapshotSyncAvailable() || !inputsResolved || !inputsAreLive) {
      return;
    }
    const heartbeat = setInterval(() => {
      const desired = desiredContentRef.current;
      // Nothing is wanted for the active assistant yet, so there is neither
      // freshness to keep nor a write to retry: a signed-out or empty session
      // before its first resolved run, and a tick coalesced past a switch. A
      // call already on the bridge is writing its own timestamp, and racing it
      // would retire the attempt it is counting on.
      if (desired === null || inFlightPayloadRef.current !== null) {
        return;
      }
      sendSnapshot(desired, assistantId);
    }, WIDGET_SNAPSHOT_HEARTBEAT_MS);
    return () => {
      clearInterval(heartbeat);
    };
  }, [assistantId, inputsResolved, inputsAreLive, sendSnapshot]);
}
