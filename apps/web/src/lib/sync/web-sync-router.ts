import {
  createSyncTagRegistry,
  type SyncDispatchResult,
  type SyncHandlerRegistration,
} from "@/lib/sync/tag-registry";
import {
  isConversationMessagesSyncTag,
  isConversationMetadataSyncTag,
  parseConversationSyncTag,
  SYNC_TAGS,
  type SyncChangedEvent,
} from "@/lib/sync/types";
import { getClientId } from "@/lib/telemetry/client-identity";
import { useConversationStore } from "@/stores/conversation-store";

export interface ActiveConversationMessagesRefreshResult {
  changed: boolean;
  messagesAdded: number;
  assistantProgress: boolean;
}

const NOOP = () => {};

export interface WebSyncRouterOptions {
  invalidateAvatar: () => void;
  refreshAssistantIdentity: (force?: boolean) => Promise<void>;
  invalidateAssistantIdentityIntro: () => void;
  invalidateAssistantConfig?: () => void;
  invalidateAssistantSounds?: () => void;
  invalidateAssistantSchedules?: () => void;
  invalidateApps?: () => void;
  refreshActiveConversationMessages: () => Promise<ActiveConversationMessagesRefreshResult>;
}

const EMPTY_DISPATCH_RESULT: SyncDispatchResult = {
  handledTags: [],
  unknownTags: [],
  invokedHandlers: 0,
  errors: [],
};

export interface WebSyncReconnectResult {
  dispatch: SyncDispatchResult;
  activeConversationMessages: ActiveConversationMessagesRefreshResult | null;
}

export interface WebSyncRouter {
  dispatchSyncChanged(event: SyncChangedEvent): Promise<SyncDispatchResult>;
  dispatchReconnect(): Promise<WebSyncReconnectResult>;
  dispose(): void;
}

export function createWebSyncRouter(
  options: WebSyncRouterOptions,
): WebSyncRouter {
  const registry = createSyncTagRegistry();
  const registrations: SyncHandlerRegistration[] = [
    registry.register(SYNC_TAGS.assistantAvatar, options.invalidateAvatar),
    registry.register(SYNC_TAGS.assistantIdentity, () =>
      options.refreshAssistantIdentity(true),
    ),
    registry.register(
      SYNC_TAGS.assistantIdentity,
      options.invalidateAssistantIdentityIntro,
      { runOnReconnect: false },
    ),
    registry.register(
      SYNC_TAGS.assistantIdentityIntro,
      options.invalidateAssistantIdentityIntro,
    ),
    registry.register(
      SYNC_TAGS.assistantConfig,
      options.invalidateAssistantConfig ?? NOOP,
    ),
    registry.register(
      SYNC_TAGS.assistantSounds,
      options.invalidateAssistantSounds ?? NOOP,
    ),
    registry.register(
      SYNC_TAGS.assistantSchedules,
      options.invalidateAssistantSchedules ?? NOOP,
    ),
    registry.register(SYNC_TAGS.appsList, options.invalidateApps ?? NOOP),
    // No-op: RootLayout's `useConversationSync` owns list-level
    // refetch (it's always mounted). Registering a real handler here
    // caused duplicate debounced refetches while ChatPage was active.
    // The no-op keeps the tag out of unknown-tag telemetry.
    registry.register(SYNC_TAGS.conversationsList, NOOP),
    registry.registerPattern(isConversationMetadataSyncTag, () => {
      // RootLayout's `useConversationSync` owns metadata tags and
      // GET-and-patches the single cached row. Handling the tag here as a
      // no-op keeps it out of unknown-tag telemetry without re-draining every
      // paginated conversation list during active turns.
    }),
    registry.registerPattern(isConversationMessagesSyncTag, ({ tag }) => {
      // List-level refetch on `:messages` tags is deliberately omitted.
      // Repaginating the full conversation list on every message
      // persist (~14 requests per write at ~300 conversations) was
      // disproportionate work for the sidebar's purposes; consumers
      // that need fresh per-conversation summary fields rely on the
      // explicit list refetch path or the per-conversation stream.
      //
      // We still need the active-conversation message refetch when
      // the tag matches the currently-open conversation — those
      // message rows are owned by a separate query.
      if (tagMatchesActiveConversation(tag)) {
        return options.refreshActiveConversationMessages().then(() => {});
      }
    }),
  ];

  return {
    dispatchSyncChanged: (event) => {
      // Defensive self-echo drop. The daemon's hub already skips the
      // originating SSE subscriber when it can match the origin client
      // id to a live subscriber; this guard catches any sync_changed
      // that still surfaces to our page with our own origin id (e.g.
      // a reconnect that re-delivered a queued event) before it can
      // fight the optimistic update the mutation's onSuccess applied.
      // Empty string is never a real id — the daemon trims and only
      // emits originClientId when truthy. We mirror the hub's length
      // check so an accidental "" never collapses to a self-match.
      if (
        event.originClientId &&
        event.originClientId === getClientId()
      ) {
        return Promise.resolve(EMPTY_DISPATCH_RESULT);
      }
      return registry.dispatch(event);
    },
    dispatchReconnect: async () => {
      const dispatch = await registry.dispatchReconnect();
      const activeConversationId = useConversationStore.getState().activeConversationId;
      let activeConversationMessages: ActiveConversationMessagesRefreshResult | null =
        null;
      if (activeConversationId) {
        try {
          activeConversationMessages =
            await options.refreshActiveConversationMessages();
        } catch {
          activeConversationMessages = null;
        }
      }
      return { dispatch, activeConversationMessages };
    },
    dispose: () => {
      for (const registration of registrations) {
        registration.dispose();
      }
    },
  };
}

function tagMatchesActiveConversation(
  tag: string,
): boolean {
  const parsed = parseConversationSyncTag(tag);
  return (
    parsed !== null &&
    parsed.conversationId === useConversationStore.getState().activeConversationId
  );
}
