import { useCallback, useEffect, useState } from 'react';

import { sendMessage } from '../../lib/chrome-message.js';
import type { GatewayUrlGetResponse } from '../../popup-state.js';

export interface SelfHostedSettingsProps {
  onPaired: () => void;
}

/**
 * Gateway URL input and pairing flow for self-hosted mode.
 * Only rendered when mode is 'self-hosted' and not yet paired.
 */
export function SelfHostedSettings({ onPaired }: SelfHostedSettingsProps) {
  const [gatewayUrl, setGatewayUrl] = useState('http://127.0.0.1:7830');
  const [pairing, setPairing] = useState(false);
  const [localStatus, setLocalStatus] = useState<string | null>(null);

  // Load saved gateway URL on mount
  useEffect(() => {
    sendMessage<GatewayUrlGetResponse>({ type: 'gateway-url-get' }).then(
      (response) => {
        if (response?.ok && response.gatewayUrl) {
          setGatewayUrl(response.gatewayUrl);
        }
      },
    );
  }, []);

  const pairAndConnect = useCallback(async () => {
    const url = gatewayUrl.trim();
    if (!url) return;

    setPairing(true);
    setLocalStatus(null);

    // Step 1: save the URL
    await sendMessage({ type: 'gateway-url-set', gatewayUrl: url });

    // Step 2: pair with the gateway
    const response = await sendMessage<{ ok: boolean; error?: string }>({
      type: 'self-hosted-pair',
    });

    if (response?.ok) {
      // Step 3: connect
      await sendMessage({ type: 'connect' });
      setPairing(false);
      onPaired();
    } else {
      setPairing(false);
      setLocalStatus(response?.error ?? 'Pairing failed');
    }
  }, [gatewayUrl, onPaired]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !pairing) {
        pairAndConnect();
      }
    },
    [pairAndConnect, pairing],
  );

  return (
    <div className="mt-1.5 mb-3.5">
      <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">
        Gateway URL
      </label>
      <div className="flex items-stretch gap-1.5">
        <input
          type="text"
          value={gatewayUrl}
          onChange={(e) => setGatewayUrl(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="http://127.0.0.1:7830"
          className="flex-1 rounded-lg border border-edge bg-bg px-2.5 py-2 font-mono text-[13px] text-fg outline-none transition-colors focus:border-fg-muted"
        />
        <button
          type="button"
          onClick={pairAndConnect}
          disabled={pairing}
          className="shrink-0 rounded-lg border border-edge bg-surface-alt px-3.5 py-2 text-xs font-medium text-fg transition-colors hover:border-edge-hover hover:bg-surface disabled:opacity-35 disabled:cursor-default"
        >
          {pairing ? 'Pairing…' : 'Pair'}
        </button>
      </div>
      <p className="mt-1.5 text-[10px] leading-snug text-fg-subtle">
        The HTTP address of your self-hosted assistant gateway.
      </p>
      {localStatus && (
        <p className="mt-1.5 break-all font-mono text-[11px] leading-relaxed text-fg-subtle">
          {localStatus}
        </p>
      )}
    </div>
  );
}
