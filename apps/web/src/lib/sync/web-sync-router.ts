import {
  createSyncTagRegistry,
  type SyncDispatchResult,
  type SyncHandlerRegistration,
} from "@/lib/sync/tag-registry.js";
import {
  isConversationMessagesSyncTag,
  isConversationMetadataSyncTag,
  parseConversationSyncTag,
  SYNC_TAGS,
  type SyncChangedEvent,
} from "@/lib/sync/types.js";

export interface ActiveConversationMessagesRefreshResult {
  changed: boolean;
  messagesAdded: number;
  assistantProgress: boolean;
}

interface CurrentRef<T> {
  current: T;
}

export interface WebSyncRouterOptions {
  activeConversationIdRef: CurrentRef<string | null>;
  invalidateAvatar: () => void;
  refreshAssistantIdentity: (force?: boolean) => Promise<void>;
  invalidateAssistantConfig: () => void;
  invalidateAssistantSounds: () => void;
  invalidateAssistantSchedules: () => void;
  scheduleConversationListRefetch: () => void;
  refreshActiveConversationMessages: () => Promise<ActiveConversationMessagesRefreshResult>;
}

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
      SYNC_TAGS.assistantConfig,
      options.invalidateAssistantConfig,
    ),
    registry.register(
      SYNC_TAGS.assistantSounds,
      options.invalidateAssistantSounds,
    ),
    registry.register(
      SYNC_TAGS.assistantSchedules,
      options.invalidateAssistantSchedules,
    ),
    registry.register(
      SYNC_TAGS.conversationsList,
      options.scheduleConversationListRefetch,
    ),
    registry.registerPattern(isConversationMetadataSyncTag, () => {
      options.scheduleConversationListRefetch();
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
      if (tagMatchesActiveConversation(tag, options.activeConversationIdRef)) {
        return options.refreshActiveConversationMessages().then(() => {});
      }
    }),
  ];

  return {
    dispatchSyncChanged: (event) => registry.dispatch(event),
    dispatchReconnect: async () => {
      const dispatch = await registry.dispatchReconnect();
      const activeConversationId = options.activeConversationIdRef.current;
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
  activeConversationIdRef: CurrentRef<string | null>,
): boolean {
  const parsed = parseConversationSyncTag(tag);
  return (
    parsed !== null &&
    parsed.conversationId === activeConversationIdRef.current
  );
}
