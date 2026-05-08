import { useCallback, useEffect, useState } from 'react';

import { useAppContext } from '../AppContext.js';
import { sendMessage } from '../lib/chrome-message.js';
import { AssistantInfoBar } from './main/AssistantInfoBar.js';
import { SelfHostedSettings } from './main/SelfHostedSettings.js';
import { SessionActions } from './main/SessionActions.js';
import { StatusCard } from './main/StatusCard.js';

/**
 * Main screen showing connection status, activity, and mode-specific
 * controls for cloud or self-hosted operation.
 */
export function MainScreen() {
  const { mode, operationCount, setScreen } = useAppContext();

  const [paired, setPaired] = useState(false);
  const [assistantName, setAssistantName] = useState('');
  const [accountEmail, setAccountEmail] = useState('');

  useEffect(() => {
    sendMessage<{
      ok: boolean;
      mode: 'self-hosted' | 'cloud' | null;
      session?: { email: string } | null;
      selectedAssistant?: { id: string; name: string } | null;
      selfHostedPaired?: boolean;
    }>({ type: 'get-session' }).then((response) => {
      if (!response?.ok) return;
      if (response.selectedAssistant?.name) {
        setAssistantName(response.selectedAssistant.name);
      }
      if (response.session?.email) {
        setAccountEmail(response.session.email);
      }
      if (response.selfHostedPaired) {
        setPaired(true);
      }
    });
  }, []);

  const handlePaired = useCallback(() => {
    setPaired(true);
  }, []);

  const handleBackToWelcome = useCallback(() => {
    setScreen({ name: 'welcome' });
  }, [setScreen]);

  const handleActivityClick = useCallback(() => {
    setScreen({ name: 'activity' });
  }, [setScreen]);

  const isCloud = mode === 'cloud';
  const isSelfHosted = mode === 'self-hosted';

  const showConnectedState = isCloud || (isSelfHosted && paired);
  const showSelfHostedSettings = isSelfHosted && !paired;

  return (
    <div className="flex min-h-[calc(300px-32px)] flex-col">
      {isCloud && (
        <AssistantInfoBar
          assistantName={assistantName || 'Assistant'}
          accountEmail={accountEmail}
        />
      )}

      {showConnectedState && <StatusCard />}

      {showConnectedState && (
        <button
          type="button"
          onClick={handleActivityClick}
          className="mb-2.5 flex w-full cursor-pointer items-center justify-between rounded-xl border border-edge bg-surface px-4 py-3.5 transition-colors hover:border-edge-hover hover:bg-surface-alt"
        >
          <div className="flex items-center gap-2.5">
            <span className="text-[13px] font-medium text-fg">Activity</span>
            <span className="rounded-[10px] bg-surface-alt px-2 py-0.5 text-[11px] font-medium text-fg-muted">
              {operationCount}
            </span>
          </div>
          <svg
            className="shrink-0 text-fg-subtle"
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
          >
            <path
              d="M5 2L10 7L5 12"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}

      {showSelfHostedSettings && <SelfHostedSettings onPaired={handlePaired} />}

      <SessionActions paired={paired} onBack={handleBackToWelcome} />
    </div>
  );
}
