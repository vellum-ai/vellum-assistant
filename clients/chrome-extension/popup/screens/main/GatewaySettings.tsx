import { useCallback, useEffect, useRef, useState } from 'react';

import { sendMessage } from '../../lib/chrome-message.js';
import type {
  GatewayUrlGetResponse,
  GetStatusResponse,
} from '../../popup-state.js';

export interface GatewaySettingsProps {
  /** Connection is failing — auto-expand so the URL editor is visible. */
  failure: boolean;
}

const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:7830';

/**
 * Collapsible "Advanced" disclosure for self-hosted mode that lets the
 * user view and edit the gateway URL their assistant listens on, then
 * save and reconnect. Auto-expands while the connection is failing.
 */
export function GatewaySettings({ failure }: GatewaySettingsProps) {
  const [open, setOpen] = useState(failure);
  const [gatewayUrl, setGatewayUrl] = useState(DEFAULT_GATEWAY_URL);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{
    kind: 'ok' | 'error';
    text: string;
  } | null>(null);

  // Auto-open when the connection transitions into a failure state, but
  // never fight a user who has manually collapsed it on a steady failure.
  const wasFailing = useRef(failure);
  useEffect(() => {
    if (failure && !wasFailing.current) setOpen(true);
    wasFailing.current = failure;
  }, [failure]);

  // Load the saved gateway URL on mount so the field reflects reality.
  useEffect(() => {
    sendMessage<GatewayUrlGetResponse>({ type: 'gateway-url-get' }).then(
      (response) => {
        if (response?.ok && response.gatewayUrl) {
          setGatewayUrl(response.gatewayUrl);
        }
      },
    );
  }, []);

  const saveAndReconnect = useCallback(async () => {
    const url = gatewayUrl.trim();
    if (!url) return;

    setSaving(true);
    setFeedback(null);

    await sendMessage({ type: 'gateway-url-set', gatewayUrl: url });
    await sendMessage({ type: 'connect' });

    // `connect` resolves even when the gateway is unreachable (the worker
    // sets health=error rather than throwing), so read the resulting
    // health to decide whether the attempt actually failed.
    const status = await sendMessage<GetStatusResponse>({ type: 'get_status' });

    setSaving(false);
    const failed =
      status?.health === 'error' ||
      status?.health === 'auth_required' ||
      status?.health === 'assistant_gone';
    setFeedback(
      failed
        ? {
            kind: 'error',
            text:
              status.healthDetail?.lastErrorMessage ??
              'Could not connect. Check the URL and that your assistant is running.',
          }
        : { kind: 'ok', text: 'Saved — reconnecting…' },
    );
  }, [gatewayUrl]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !saving) saveAndReconnect();
    },
    [saveAndReconnect, saving],
  );

  return (
    <div className="mb-2.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center justify-between rounded-xl border border-edge bg-surface px-4 py-3.5 transition-colors hover:border-edge-hover hover:bg-surface-alt"
      >
        <span className="text-[13px] font-medium text-fg">Advanced</span>
        <svg
          className={`shrink-0 text-fg-subtle transition-transform duration-200 ${open ? 'rotate-90' : ''}`}
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

      {open && (
        <div className="mt-1.5 animate-fade-up rounded-xl border border-edge bg-surface px-4 py-3.5">
          <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">
            Gateway URL
          </label>
          <input
            type="text"
            value={gatewayUrl}
            onChange={(e) => setGatewayUrl(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={DEFAULT_GATEWAY_URL}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="w-full rounded-lg border border-edge bg-bg px-2.5 py-2 font-mono text-[13px] text-fg outline-none transition-colors focus:border-fg-muted"
          />
          <p className="mt-1.5 text-[10px] leading-snug text-fg-subtle">
            The HTTP address your self-hosted assistant gateway listens on.
          </p>
          <button
            type="button"
            onClick={saveAndReconnect}
            disabled={saving}
            className="mt-2.5 w-full rounded-lg border border-edge bg-surface-alt px-3 py-2 text-xs font-medium text-fg transition-colors hover:border-edge-hover hover:bg-surface disabled:cursor-default disabled:opacity-35"
          >
            {saving ? 'Reconnecting…' : 'Save & reconnect'}
          </button>
          {feedback && (
            <p
              className={`mt-2 break-all text-[11px] leading-relaxed ${feedback.kind === 'error' ? 'text-danger' : 'text-fg-subtle'}`}
            >
              {feedback.text}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
