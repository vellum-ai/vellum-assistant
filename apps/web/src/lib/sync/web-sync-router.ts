// TODO: port from platform
export interface ActiveConversationMessagesRefreshResult {
  messages: unknown[];
  hasMore: boolean;
  changed: boolean;
  messagesAdded: number;
  assistantProgress: unknown;
  activeConversationMessages?: ActiveConversationMessagesRefreshResult;
}

export interface WebSyncRouter {
  sync: () => void;
  dispatchReconnect: () => Promise<ActiveConversationMessagesRefreshResult>;
  refreshMessages: () => Promise<ActiveConversationMessagesRefreshResult>;
}

export function useWebSyncRouter(): WebSyncRouter {
  return {
    sync: () => {},
    dispatchReconnect: () => Promise.resolve({ messages: [], hasMore: false, changed: false, messagesAdded: 0, assistantProgress: null }),
    refreshMessages: () => Promise.resolve({ messages: [], hasMore: false, changed: false, messagesAdded: 0, assistantProgress: null }),
  };
}
