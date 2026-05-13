import { useCallback, useState } from 'react';

import { useAppContext } from '../../AppContext.js';
import {
  type ConnectionHealthState,
  deriveHealthStatusDisplay,
  deriveSetupMessage,
  healthToPhase,
} from '../../popup-state.js';

function statusBadgeDisplay(health: ConnectionHealthState): { text: string; bgClass: string; textClass: string } {
  switch (health) {
    case 'connected':
      return { text: 'Online', bgClass: 'bg-success-soft', textClass: 'text-success' };
    case 'connecting':
      return { text: 'Starting', bgClass: 'bg-warning-soft', textClass: 'text-warning' };
    case 'reconnecting':
      return { text: 'Recovering', bgClass: 'bg-warning-soft', textClass: 'text-warning' };
    case 'paused':
      return { text: 'Paused', bgClass: 'bg-warning-soft', textClass: 'text-warning' };
    case 'auth_required':
      return { text: 'Needs action', bgClass: 'bg-danger-soft', textClass: 'text-danger' };
    case 'assistant_gone':
      return { text: 'Assistant removed', bgClass: 'bg-danger-soft', textClass: 'text-danger' };
    case 'error':
      return { text: 'Issue detected', bgClass: 'bg-danger-soft', textClass: 'text-danger' };
    default:
      return { text: 'Unknown', bgClass: 'bg-surface-alt', textClass: 'text-fg-subtle' };
  }
}

function dotClasses(dotClass: string): string {
  switch (dotClass) {
    case 'connected':
      return 'bg-success shadow-[0_0_8px_rgba(74,222,128,0.5)] animate-pulse-ring';
    case 'paused':
      return 'bg-warning shadow-[0_0_6px_rgba(251,191,36,0.3)]';
    case 'disconnected':
      return 'bg-danger shadow-[0_0_6px_rgba(251,113,133,0.35)]';
    default:
      return 'bg-fg-subtle';
  }
}

/**
 * Connection health display card with status dot, text, badge,
 * error/debug details, and setup message.
 */
export function StatusCard() {
  const { health, healthDetail } = useAppContext();
  const [copyLabel, setCopyLabel] = useState('Copy');

  const display = deriveHealthStatusDisplay(health, healthDetail);
  const badge = statusBadgeDisplay(health);
  const phase = healthToPhase(health);
  const setupMsg = deriveSetupMessage(phase);

  const showError =
    healthDetail?.lastErrorMessage &&
    (health === 'auth_required' || health === 'error');

  const handleCopy = useCallback(async () => {
    if (!healthDetail?.lastErrorMessage) return;
    try {
      await navigator.clipboard.writeText(healthDetail.lastErrorMessage);
      setCopyLabel('Copied!');
      setTimeout(() => setCopyLabel('Copy'), 1500);
    } catch {
      // Clipboard API may fail in some contexts; ignore.
    }
  }, [healthDetail?.lastErrorMessage]);

  return (
    <>
      <div className="rounded-xl border border-edge bg-surface px-4 py-3.5 mb-2.5 transition-[border-color,box-shadow] duration-[400ms]">
        <div className="flex items-center justify-between gap-2.5">
          <div className="flex items-center gap-2.5 min-w-0">
            <div
              className={`size-2.5 shrink-0 rounded-full transition-[background,box-shadow] duration-300 ${dotClasses(display.dotClass)}`}
            />
            <p className="text-[13px] font-medium leading-snug text-fg">
              {display.text}
            </p>
          </div>
          <span
            className={`shrink-0 rounded-[5px] px-[7px] py-[3px] text-[10px] font-semibold uppercase tracking-wide ${badge.bgClass} ${badge.textClass}`}
          >
            {badge.text}
          </span>
        </div>
      </div>

      {/* Error alert */}
      {showError && (
        <p className="mb-2.5 rounded-lg border border-danger-soft bg-danger-soft px-3 py-2.5 text-xs leading-relaxed text-danger">
          {healthDetail.lastErrorMessage}
        </p>
      )}

      {/* Debug details */}
      {showError && (
        <div className="mb-2.5 rounded-lg border border-edge bg-white/[0.03] px-2.5 py-2">
          <div className="flex items-center justify-between gap-2.5 mb-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">
              Debug details
            </span>
            <button
              type="button"
              onClick={handleCopy}
              className="rounded-md border border-edge bg-surface-alt px-2 py-1 text-[10px] font-medium text-fg transition-colors hover:border-edge-hover hover:bg-surface"
            >
              {copyLabel}
            </button>
          </div>
          <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-fg-muted">
            {healthDetail.lastErrorMessage}
          </pre>
        </div>
      )}

      {/* Setup message */}
      {setupMsg && (
        <p className="mb-2.5 rounded-lg border border-warning-soft bg-warning-soft px-3 py-2.5 text-xs leading-relaxed text-warning">
          {setupMsg}
        </p>
      )}
    </>
  );
}
