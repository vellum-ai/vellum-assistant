import { useCallback, useEffect, useState } from 'react';

import { useAppContext } from '../AppContext.js';
import { sendMessage } from '../lib/chrome-message.js';
import { AssistantInfoBar } from './main/AssistantInfoBar.js';
import { GatewaySettings } from './main/GatewaySettings.js';
import { SessionActions } from './main/SessionActions.js';
import { StatusCard } from './main/StatusCard.js';

/**
 * Main screen showing connection status, activity, and mode-specific
 * controls for cloud or self-hosted operation.
 */
export function MainScreen() {
  const { mode, health, operationCount, selfHostedPaired, assistantsError, setScreen, onSignOut, onRetryAssistants } = useAppContext();

  const [paired, setPaired] = useState(selfHostedPaired);
  const [assistantName, setAssistantName] = useState('');
  const [accountEmail, setAccountEmail] = useState('');
  const [deslopError, setDeslopError] = useState('');

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

  const handleActivityClick = useCallback(() => {
    setScreen({ name: 'activity' });
  }, [setScreen]);

  const handleFeedbackClick = useCallback(() => {
    setScreen({ name: 'feedback' });
  }, [setScreen]);

  const handleDeslopClick = useCallback(() => {
    setDeslopError('');
    sendMessage<{ ok: boolean; error?: string }>({
      type: 'deslop-activate',
    }).then((response) => {
      if (response?.ok) {
        // Close the popup so the user can pick an element on the page.
        window.close();
        return;
      }
      setDeslopError(response?.error ?? 'Could not start Deslop on this page.');
    });
  }, []);

  const isCloud = mode === 'cloud';
  const isSelfHosted = mode === 'self-hosted';

  const showConnectedState = isCloud || (isSelfHosted && paired);
  const connectionFailing =
    health === 'error' || health === 'auth_required' || health === 'reconnecting';

  return (
    <div className="flex min-h-[calc(300px-32px)] flex-col">
      {isCloud && (
        <AssistantInfoBar
          assistantName={assistantName || 'Assistant'}
          accountEmail={accountEmail}
        />
      )}

      {assistantsError && (
        <div className="mx-0 mb-2.5 rounded-xl border border-red-300 bg-red-50 px-4 py-3 dark:border-red-700 dark:bg-red-950">
          <p className="text-[13px] text-red-700 dark:text-red-300">
            {assistantsError}
          </p>
          <button
            type="button"
            onClick={onRetryAssistants}
            className="mt-2 cursor-pointer rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
          >
            Retry
          </button>
        </div>
      )}

      {showConnectedState && <StatusCard />}

      {showConnectedState && (
        <div className="mb-2.5">
          <button
            type="button"
            onClick={handleDeslopClick}
            className="flex w-full cursor-pointer items-center justify-between rounded-xl border border-edge bg-surface px-4 py-3.5 transition-colors hover:border-edge-hover hover:bg-surface-alt"
          >
            <div className="flex items-center gap-2.5">
              <svg
                className="shrink-0 text-fg-muted"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
              >
                <path
                  d="M15 4V2M15 10V8M8 9h2M20 9h2M17.8 11.8L19 13M17.8 6.2L19 5M3 21l9-9M12.2 6.2L11 5"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="text-[13px] font-medium text-fg">Deslop</span>
            </div>
            <span className="text-[11px] text-fg-subtle">
              Click text on the page to rewrite it
            </span>
          </button>
          {deslopError && (
            <p className="mt-1.5 px-1 text-[11px] text-red-600 dark:text-red-400">
              {deslopError}
            </p>
          )}
        </div>
      )}

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

      {isSelfHosted && <GatewaySettings failure={connectionFailing} />}

      <button
        type="button"
        onClick={handleFeedbackClick}
        className="mb-2.5 flex w-full cursor-pointer items-center justify-between rounded-xl border border-edge bg-surface px-4 py-3.5 transition-colors hover:border-edge-hover hover:bg-surface-alt"
      >
        <span className="text-[13px] font-medium text-fg">Share Feedback</span>
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

      <SessionActions paired={paired} onBack={onSignOut} />
    </div>
  );
}
