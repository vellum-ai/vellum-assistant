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
  activeConversationKeyRef: CurrentRef<string | null>;
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
      options.scheduleConversationListRefetch();
      if (tagMatchesActiveConversation(tag, options.activeConversationKeyRef)) {
        return options.refreshActiveConversationMessages().then(() => {});
      }
    }),
  ];

  return {
    dispatchSyncChanged: (event) => registry.dispatch(event),
    dispatchReconnect: async () => {
      const dispatch = await registry.dispatchReconnect();
      const activeConversationKey = options.activeConversationKeyRef.current;
      let activeConversationMessages: ActiveConversationMessagesRefreshResult | null =
        null;
      if (activeConversationKey) {
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
  activeConversationKeyRef: CurrentRef<string | null>,
): boolean {
  const parsed = parseConversationSyncTag(tag);
  return (
    parsed !== null &&
    parsed.conversationId === activeConversationKeyRef.current
  );
}
