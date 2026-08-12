import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";
import { Notice } from "@vellumai/design-library/components/notice";

import { DetailCard } from "@/components/detail-card";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useSupportsRemoteWebPairing } from "@/lib/backwards-compat/remote-web-pairing-gate";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";

import { resolvePairDeviceTarget } from "./pair-device-client";
import { PairDeviceReady } from "./pair-device-ready";
import { usePairDevice } from "./use-pair-device";

/**
 * Settings card that pairs another device to this assistant without shell
 * commands —
 * the UI equivalent of `vellum pair --qr`. It mints and auto-approves a
 * device-code challenge against the host's loopback gateway and renders the
 * https pair URL as a QR with a copyable link and expiry countdown.
 *
 * Rendered only in desktop/local mode against an on-machine gateway (the gate
 * lives in {@link resolvePairDeviceTarget}) whose assistant version serves the
 * pairing routes ({@link useSupportsRemoteWebPairing}) and whose
 * `web-remote-ingress` flag is on, so a code minted here can always connect.
 * The flag is read only once the store has hydrated, since before that it
 * reports the registry default rather than this assistant's value: the card
 * appears a beat late rather than appearing and then vanishing.
 */
export function PairDeviceCard() {
  const target = resolvePairDeviceTarget();
  const supported = useSupportsRemoteWebPairing();
  const flagsHydrated = useAssistantFeatureFlagStore.use.hasHydrated();
  const webRemoteIngressOn =
    useAssistantFeatureFlagStore.use.webRemoteIngress();
  const pair = usePairDevice(
    target?.base ?? null,
    webRemoteIngressOn,
    target?.ingressUrl ?? null,
  );
  const { copy, copied } = useCopyToClipboard({
    errorMessage: "Could not copy the pairing address.",
  });

  if (!target || !supported || !flagsHydrated || !webRemoteIngressOn) {
    return null;
  }

  const { phase } = pair;
  const isMinting = phase.kind === "minting";
  const isReady = phase.kind === "ready";
  const prefilledFromTunnel = pair.prefillSource === "tunnel";
  // Honest empty state: no recorded tunnel URL, no stored value, field still
  // empty. Advanced users can still type an address into the field below.
  const showNoTunnelGuidance =
    pair.prefillSource === "none" && pair.publicBaseUrl.trim() === "";
  const buttonLabel = isMinting
    ? "Generating…"
    : isReady
      ? "Generate new code"
      : "Generate pairing QR";

  return (
    <DetailCard
      title="Pair a device"
      subtitle={`Scan with another device's camera — or open the link on it — to use ${
        target.assistantName ?? "this assistant"
      } there.`}
    >
      <div className="flex flex-col gap-4">
        {showNoTunnelGuidance && (
          <Notice tone="info" title="No tunnel detected">
            {
              "On this computer, run `vellum tunnel --provider tailscale` (or another provider) — its address appears here."
            }
          </Notice>
        )}
        <div className="flex flex-col gap-3">
          <Input
            label="Public URL"
            fullWidth
            placeholder="https://your-assistant.ts.net"
            helperText={
              prefilledFromTunnel
                ? "This address comes from `vellum tunnel` on this computer. Edit it if your devices reach this assistant at a different URL."
                : "The https address your devices can reach this assistant at (your Tailscale URL, or another tunnel's)."
            }
            value={pair.publicBaseUrl}
            errorText={pair.inputError ?? undefined}
            disabled={isMinting}
            onChange={(event) => pair.setPublicBaseUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                pair.generate();
              }
            }}
          />
          <Button
            variant="primary"
            className="self-start"
            disabled={isMinting || pair.publicBaseUrl.trim() === ""}
            onClick={pair.generate}
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
