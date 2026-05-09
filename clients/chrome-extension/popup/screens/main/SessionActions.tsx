import { useCallback } from 'react';

import { useAppContext } from '../../AppContext.js';
import { sendMessage } from '../../lib/chrome-message.js';

export interface SessionActionsProps {
  paired: boolean;
  onBack: () => void;
}

/**
 * Bottom action buttons: optional reconnect, divider, and sign-out /
 * disconnect / back button depending on mode and paired state.
 */
export function SessionActions({ paired, onBack }: SessionActionsProps) {
  const { mode, health, onSignOut } = useAppContext();

  const isFailure =
    health === 'error' || health === 'auth_required' || health === 'reconnecting';

  const handleReconnect = useCallback(() => {
    sendMessage({ type: 'connect' });
  }, []);

  // Determine the label and action for the bottom button
  let actionLabel: string;
  let actionHandler: () => void;

  if (mode === 'cloud') {
    actionLabel = 'Sign out';
    actionHandler = onSignOut;
  } else if (paired) {
    actionLabel = 'Disconnect';
    actionHandler = onSignOut;
  } else {
    actionLabel = 'Back';
    actionHandler = onBack;
  }

  return (
    <div className="mt-auto flex flex-col items-center pt-1">
      {/* Reconnect button: only in self-hosted + failure state */}
      {mode === 'self-hosted' && isFailure && (
        <button
          type="button"
          onClick={handleReconnect}
          className="mb-2.5 w-full rounded-lg border border-edge bg-surface-alt px-3 py-2.5 text-xs font-medium text-fg transition-colors hover:border-edge-hover hover:bg-surface"
        >
          Reconnect with assistant
        </button>
      )}

      <div className="w-full border-t border-edge" />

      <button
        type="button"
        onClick={actionHandler}
        className="border-none bg-transparent px-0 py-2 text-[11px] text-fg-subtle transition-colors hover:text-fg-muted"
      >
        {actionLabel}
      </button>
    </div>
  );
}
