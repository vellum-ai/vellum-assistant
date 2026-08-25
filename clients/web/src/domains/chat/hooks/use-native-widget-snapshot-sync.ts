import { useCallback, useEffect, useMemo, useRef } from "react";

import {
  useCanQueryDaemon,
  useUnreadConversationCount,
} from "@/hooks/conversation-queries";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { resolveRenderedAvatarAccentHex } from "@/hooks/use-avatar-accent-var";
import { useTranslation } from "@/i18n";
import {
  clearWidgetSnapshot,
  isWidgetSnapshotSyncAvailable,
  readWidgetSnapshotAssistantId,
  retryPendingWidgetSnapshotClear,
  syncWidgetSnapshot,
  WIDGET_SNAPSHOT_SCHEMA_VERSION,
  type WidgetSnapshotAvatar,
  type WidgetSnapshotConversation,
  type WidgetSnapshotPayload,
} from "@/runtime/widget-snapshot";
import { useConversationStore } from "@/stores/conversation-store";
import type {
  Conversation,
  ConversationGroup,
} from "@/types/conversation-types";
import {
  memoizedAvatarEncode,
  type AvatarEncodeMemo,
} from "@/utils/avatar-island-encode";
import { resolveAvatarRender, type AvatarRender } from "@/utils/avatar-render";
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

/**
 * Byte ceiling for the avatar image a snapshot carries.
 *
 * Deliberately not the Live Activity's ceiling, which the shared encoder takes
 * as its default: that one is ActivityKit's attribute budget, where going over
 * costs the whole activity, so it is measured in single kilobytes. The two
 * budgets are why {@link memoizedAvatarEncode} caches per budget rather than
 * per avatar alone. This payload is a UserDefaults write into an App Group, and
 * a widget draws the avatar far larger than an island does, so the budget is
 * set by what is worth writing rather than by what will start. The shell
 * rejects anything past its own cap, which sits above this one.
 */
const WIDGET_AVATAR_MAX_BYTES = 64_000;

/**
 * Size the character avatar is composited at before it is rasterized.
 *
 * The composited SVG is resolution-independent, so this only caps the top of
 * the encoder's ladder rather than setting the size a widget draws. Matches
 * what `useIslandAvatarSource` composites for the Live Activity, so the two
 * native surfaces rasterize the same source.
 */
const AVATAR_SOURCE_SIZE = 128;

/** A snapshot before it is stamped and before its avatar bytes are attached. */
type SnapshotContent = Omit<WidgetSnapshotPayload, "generatedAt" | "avatar">;

/**
 * The avatar as the dedup key sees it.
 *
 * `image` is the identity of the encoded bytes rather than the bytes
 * themselves: a widget-sized avatar is tens of kilobytes of base64, and
 * re-serializing that on every list re-render is exactly the cost the key
 * exists to avoid. It has to be in the key at all because a photo swapped for
 * another photo changes neither the kind nor the accent, and would otherwise
 * never reach the Home Screen.
 */
interface SnapshotAvatarFingerprint {
  kind: WidgetSnapshotAvatar["kind"];
  accentHex: string | null;
  image: number;
}

/**
 * The avatar the next snapshot should carry, starting its encode if this is
 * the first read since it changed.
 *
 * The encode is a canvas draw memoized at module scope by
 * {@link memoizedAvatarEncode}, shared with the Live Activity mirror for one
 * owner of the caching and failure rules rather than one draw across both: the
 * mirror resolves its own render and reads at its own budget, so each surface
 * encodes separately. An encode that fails or fits nothing is an avatar-less
 * snapshot, never a missing one: the counts and the rows are what the widgets
 * are for. Only a failure is retried, and the memo owns that distinction.
 *
 * `source` and `accentHex` are resolved reactively by the hook rather than read
 * back from the two imperative publishers in `RootLayout`. Those are written by
 * a parent's effect, and React runs a child's effects first, so a sync that
 * read them would be a render behind whenever the avatar and the conversation
 * data move in the same commit. An in-SPA assistant switch into an already
 * cached destination is exactly that commit, and the stale face would then be
 * pinned by the dedup key until the heartbeat.
 */
function snapshotAvatar(
  source: AvatarRender,
  accentHex: string | null,
): {
  fingerprint: SnapshotAvatarFingerprint;
  encode: AvatarEncodeMemo;
} {
  const encode = memoizedAvatarEncode(source, WIDGET_AVATAR_MAX_BYTES);
  return {
    fingerprint: {
      kind: source.kind,
      accentHex,
      image: encode.revision,
    },
    encode,
  };
}

/** The dedup key: everything a snapshot says, with the avatar as an identity. */
function snapshotKey(
  content: SnapshotContent,
  avatar: SnapshotAvatarFingerprint,
): string {
  return JSON.stringify({ ...content, avatar });
}

/**
 * Mirror the conversation list into the iOS shell's `WidgetSnapshot` plugin
 * so the Home Screen widgets can draw unread and in-progress counts, the three
 * most recent chats, and the assistant's own avatar. No-ops everywhere but
 * Capacitor iOS.
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
 * every re-render of the layout. The avatar is in that key as an identity
 * rather than as its bytes (see {@link SnapshotAvatarFingerprint}), and the
 * bytes are attached as the payload is sent.
 *
 * The avatar is a reactive input rather than a read taken as the payload is
 * built, so an avatar that changes with nothing else re-runs the sync instead
 * of waiting for whatever re-renders the layout next. It is resolved here from
 * the same query `RootLayout` derives its published copies from, not read back
 * through those publishers: they are written by a parent's effect, which React
 * runs after this layout's, so a read would be a render behind whenever an
 * avatar change and a conversation change land in one commit. That is precisely
 * an in-SPA assistant switch whose destination is already cached, and the dedup
 * key would then hold the previous assistant's face on the Home Screen until
 * the heartbeat.
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
 * The avatar query is held to the same standard, and it is not the caller's to
 * pass: this hook subscribes to it directly, so it applies that half itself.
 * A first load in flight serves the null avatar, and it routinely settles after
 * the conversation list does, so a gate that watched only the conversations
 * would ship `kind: "none"` as the run's first snapshot. The plugin replaces
 * the App Group record whole, so that write wipes the themed avatar a previous
 * run left behind and every widget flashes to the brand palette until a second
 * sync repaints it. Only the FIRST load holds: an errored avatar query, a
 * gated-off one, and a background refetch all report resolved, because none of
 * them has an avatar arriving that waiting would find.
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

  // The active assistant's avatar, off the same query and through the same
  // resolvers `RootLayout` publishes from, so the widget can never draw a
  // different face than the app does. Subscribed rather than read back from
  // those publishers: see {@link snapshotAvatar}. The query is already mounted
  // at root scope, so this is another observer on a cached entry rather than a
  // second fetch.
  const avatar = useAssistantAvatar(assistantId);
  const avatarSource = useMemo(
    () =>
      resolveAvatarRender(
        avatar.customImageUrl,
        avatar.components,
        avatar.traits,
        AVATAR_SOURCE_SIZE,
      ),
    [avatar.customImageUrl, avatar.components, avatar.traits],
  );
  const avatarAccentHex = resolveRenderedAvatarAccentHex(
    avatar.components,
    avatar.traits,
    avatar.customImageUrl,
  );
  // The avatar query is in the resolution guard alongside the conversation
  // queries the caller passes, and holds a sync the same way they do. It serves
  // the null avatar while it loads and settles after them often enough to be
  // the ordinary cold launch, so a gate without it would blank the widgets'
  // avatar on the first write of every run.
  //
  // `isLoading` is the first load alone. An errored query, one gated off for
  // want of an active assistant, and a background refetch all report false,
  // which is right for each: none has an avatar arriving that waiting would
  // find, and the last still has the one the app is drawing.
  const avatarResolved = assistantId === null || !avatar.isLoading;
  const snapshotResolved = inputsResolved && avatarResolved;

  // The one way to the bridge, shared by data syncs and the heartbeat so a
  // heartbeat cannot corrupt the bookkeeping a data sync depends on.
  const sendSnapshot = useCallback(
    (
      content: SnapshotContent,
      ownerId: string | null,
      source: AvatarRender,
      accentHex: string | null,
    ): void => {
      const { fingerprint, encode } = snapshotAvatar(source, accentHex);
      const serialized = snapshotKey(content, fingerprint);
      // The producer is recorded as the call is fired rather than when it
      // lands. A write already on the bridge can land at any moment, so a
      // switch that happens in between has to see this assistant as an owner.
      // Naming one too eagerly costs at most an idempotent clear; naming one
      // too late leaves another assistant's titles on a Home Screen that never
      // reloads.
      syncedAssistantIdRef.current = ownerId;
      inFlightPayloadRef.current = serialized;
      const attempt = (syncAttemptRef.current += 1);
      const write = (imageBase64: string | null): void => {
        // Retires a write the wait below outlived: an assistant switch clears
        // the App Group, and a snapshot landing after it would put the
        // departed assistant's rows straight back on the Home Screen.
        if (attempt !== syncAttemptRef.current) {
          return;
        }
        void syncWidgetSnapshot(
          {
            ...content,
            avatar: {
              kind: fingerprint.kind,
              accentHex: fingerprint.accentHex,
              imageBase64,
            },
            generatedAt: new Date().toISOString(),
          },
          ownerId,
          // The same retirement, read from inside the call. The check above
          // only covers the wait on the draw, and an unmount or a switch lands
          // just as readily while the module is honoring an owed clear, where
          // this is what keeps a payload nothing wants any more off the bridge.
          () => attempt !== syncAttemptRef.current,
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
      };
      // Only the first snapshot after an avatar change waits on the canvas
      // draw; every later one reads the bytes it left behind and stays
      // synchronous with the render that fired it.
      if (encode.pending === null) {
        write(encode.base64);
        return;
      }
      void encode.pending.then(write);
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

  // A write must not outlive the hook. Signing out clears the App Group and
  // unmounts this layout while a first avatar encode can still be in flight;
  // retiring every attempt here makes that write's own re-check drop it
  // instead of putting the departed account's rows back on the Home Screen.
  // The retirement is also handed to `syncWidgetSnapshot`, so an unmount that
  // arrives once the payload is past that check still holds the write back for
  // as long as it has not reached the plugin. A write already on the bridge by
  // then is left where it lands: an unmount on its own is an app closing or a
  // layout swapping out, and the snapshot should survive both. The sign-out
  // that empties the App Group does so through its own clear, and that is what
  // such a write is corrected against.
  useEffect(() => {
    const attempts = syncAttemptRef;
    return () => {
      attempts.current += 1;
    };
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

    if (!snapshotResolved) {
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

    // Built without `generatedAt` and without the avatar's bytes, so the
    // serialized form is the dedup key.
    const content: SnapshotContent = {
      schemaVersion: WIDGET_SNAPSHOT_SCHEMA_VERSION,
      unreadCount,
      inProgressCount,
      conversations: rows,
    };
    const serialized = snapshotKey(
      content,
      snapshotAvatar(avatarSource, avatarAccentHex).fingerprint,
    );
    // Recorded whether or not this run sends it, since it describes what the
    // App Group should hold rather than what reached it.
    desiredContentRef.current = content;
    if (
      serialized === lastPayloadRef.current ||
      serialized === inFlightPayloadRef.current
    ) {
      return;
    }
    sendSnapshot(content, assistantId, avatarSource, avatarAccentHex);
  }, [
    assistantId,
    conversations,
    conversationGroups,
    processingConversationIds,
    unreadCount,
    snapshotResolved,
    avatarSource,
    avatarAccentHex,
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
  //
  // The avatar is a dependency, so a change re-arms the interval. That is the
  // wanted behavior rather than a cost: the same change syncs a fresh
  // `generatedAt` through the effect above, so restarting the window from that
  // write is what the timer would be counting from anyway.
  useEffect(() => {
    if (
      !isWidgetSnapshotSyncAvailable() ||
      !snapshotResolved ||
      !inputsAreLive
    ) {
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
      sendSnapshot(desired, assistantId, avatarSource, avatarAccentHex);
    }, WIDGET_SNAPSHOT_HEARTBEAT_MS);
    return () => {
      clearInterval(heartbeat);
    };
  }, [
    assistantId,
    snapshotResolved,
    inputsAreLive,
    avatarSource,
    avatarAccentHex,
    sendSnapshot,
  ]);
}
