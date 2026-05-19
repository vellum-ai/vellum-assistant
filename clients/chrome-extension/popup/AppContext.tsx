import { createContext, useContext } from 'react';

import type { AssistantAuthProfile } from '../background/assistant-auth-profile.js';
import type { CloudAssistant } from '../background/cloud-api.js';
import type { OperationEntry } from '../background/event-log.js';
import type { ConnectionHealthDetail, ConnectionHealthState } from './popup-state.js';

export type Screen =
  | { name: 'welcome' }
  | { name: 'picker'; assistants: CloudAssistant[]; email?: string }
  | { name: 'main' }
  | { name: 'activity' }
  | { name: 'detail'; operation: OperationEntry }
  | { name: 'feedback' };

export interface AppContextValue {
  mode: 'self-hosted' | 'cloud' | null;
  health: ConnectionHealthState;
  healthDetail: ConnectionHealthDetail;
  authProfile: AssistantAuthProfile | null;
  operationCount: number;
  selfHostedPaired: boolean;
  assistantsError: string | null;
  setScreen: (screen: Screen) => void;
  onSignOut: () => void;
  onRetryAssistants: () => void;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useAppContext(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error('useAppContext must be used within an AppContext.Provider');
  }
  return ctx;
}
