import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";
import { Notice } from "@vellumai/design-library/components/notice";

import { DetailCard } from "@/components/detail-card";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useSupportsRemoteWebPairing } from "@/lib/backwards-compat/remote-web-pairing-gate";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";

import { resolvePairDeviceGatewayBase } from "./pair-device-client";
import { PairDeviceReady } from "./pair-device-ready";
import { usePairDevice } from "./use-pair-device";

/**
 * Settings card that pairs a phone to this assistant without shell commands —
 * the UI equivalent of `vellum pair --qr`. It mints and auto-approves a
 * device-code challenge against the host's loopback gateway and renders the
 * https pair URL as a QR with a copyable link and expiry countdown.
 *
 * Rendered only in desktop/local mode against an on-machine gateway (the gate
 * lives in {@link resolvePairDeviceGatewayBase}) whose assistant version
 * serves the pairing routes ({@link useSupportsRemoteWebPairing}); a remote or
 * platform session, or an older assistant, sees nothing. Generating also
 * requires the `web-remote-ingress` flag — checked before minting, like the
 * CLI, so a rendered QR always represents a scannable pairing.
 */
export function PairDeviceCard() {
  const base = resolvePairDeviceGatewayBase();
  const supported = useSupportsRemoteWebPairing();
  const flagsHydrated = useAssistantFeatureFlagStore.use.hasHydrated();
  const webRemoteIngressOn = useAssistantFeatureFlagStore.use.webRemoteIngress();
  const pair = usePairDevice(base, webRemoteIngressOn);
  const { copy, copied } = useCopyToClipboard();

  if (!base || !supported) {
    return null;
  }

  const { phase } = pair;
  const isMinting = phase.kind === "minting";
  const isReady = phase.kind === "ready";
  // Until the feature-flag store hydrates, webRemoteIngressOn is the registry
  // default (false), not this assistant's real value, so the mint precheck
  // can't be trusted until hasHydrated is true.
  const buttonLabel = !flagsHydrated
    ? "Loading…"
    : isMinting
      ? "Generating…"
      : isReady
        ? "Generate new code"
        : "Generate pairing QR";

  // Both the button and the Enter key mint through here, so the flag precheck
  // is never evaluated against the pre-hydration default.
  const handleGenerate = () => {
    if (!flagsHydrated) {
      return;
    }
    pair.generate();
  };

  return (
    <DetailCard
      title="Pair a device"
      subtitle="Scan from your phone's camera to open this assistant on it."
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3">
          <Input
            label="Public URL"
            fullWidth
            placeholder="https://your-assistant.ts.net"
            helperText="The https address your phone can reach this assistant at (e.g. your Tailscale or tunnel URL)."
            value={pair.publicBaseUrl}
            errorText={pair.inputError ?? undefined}
            disabled={isMinting}
            onChange={(event) => pair.setPublicBaseUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                handleGenerate();
              }
            }}
          />
          <Button
            variant="primary"
            className="self-start"
            disabled={
              !flagsHydrated || isMinting || pair.publicBaseUrl.trim() === ""
            }
            onClick={handleGenerate}
          >
            {buttonLabel}
          </Button>
        </div>

        {phase.kind === "error" && (
          <Notice tone="error" title={phase.message}>
            {phase.hint}
          </Notice>
        )}

        {isReady && (
          <PairDeviceReady
            pairUrl={phase.pairUrl}
            remainingMs={pair.remainingMs}
            expired={pair.expired}
            copied={copied}
            onCopy={copy}
          />
        )}
      </div>
    </DetailCard>
  );
}
