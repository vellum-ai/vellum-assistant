// TODO: port from platform
export interface UseTerminalSessionArgs {
  assistantId?: string;
  conversationId?: string;
}

export interface UseTerminalSessionResult {
  sessionId: string | null;
  isConnected: boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
}

export function useTerminalSession(_args?: UseTerminalSessionArgs): UseTerminalSessionResult {
  return { sessionId: null, isConnected: false, connect: async () => {}, disconnect: async () => {} };
}
