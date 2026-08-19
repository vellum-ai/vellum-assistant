import { useState } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";
import { Notice } from "@vellumai/design-library/components/notice";

import { DetailCard } from "@/components/detail-card";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useTranslation } from "@/i18n";
import { useSupportsRemoteWebPairing } from "@/lib/backwards-compat/remote-web-pairing-gate";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";

import { resolvePairDeviceTarget } from "./pair-device-client";
import { PairDeviceReady } from "./pair-device-ready";
import { PairedDevicesSection } from "./paired-devices-section";
import { PendingPairingRequests } from "./pending-pairing-requests";
import { usePairDevice } from "./use-pair-device";

/**
 * Settings card that pairs another device to this assistant without shell
 * commands —
 * the UI equivalent of `vellum pair --qr`. It mints and auto-approves a
 * device-code challenge against the host's loopback gateway and renders the
 * https pair URL as a QR with a copyable link and expiry countdown. It also
 * hosts the approval list for pairing requests minted elsewhere
 * ({@link PendingPairingRequests}).
 *
 * Rendered only in desktop/local mode against an on-machine gateway (the gate
 * lives in {@link resolvePairDeviceTarget}) whose assistant version serves the
 * pairing routes ({@link useSupportsRemoteWebPairing}). The client-scoped
 * `web-remote-ingress` flag decides only whether this card renders; it gates
 * no pairing functionality. The client-scoped `paired-devices-ui` flag decides
 * only whether the paired-devices list + revoke section renders inside the
 * card; revocation itself stays available via `vellum devices` on the host.
 */
export function PairDeviceCard() {
  const { t } = useTranslation("settings");
  const target = resolvePairDeviceTarget();
  const supported = useSupportsRemoteWebPairing();
  const webRemoteIngressOn = useClientFeatureFlagStore.use.webRemoteIngress();
  const pairedDevicesUIOn = useClientFeatureFlagStore.use.pairedDevicesUI();
  const pair = usePairDevice(target?.base ?? null, target?.ingressUrl ?? null);
  // Bumped when the pending-request flow pairs a device, so the device list
  // below refetches without waiting for a live-code poll.
  const [devicesRevalidateKey, setDevicesRevalidateKey] = useState(0);
  const { copy, copied } = useCopyToClipboard({
    errorMessage: t("pairDeviceCard.copyError"),
  });

  if (!target || !supported || !webRemoteIngressOn) {
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
    ? t("pairDeviceCard.generateButtonMinting")
    : isReady
      ? t("pairDeviceCard.generateButtonRegenerate")
      : t("pairDeviceCard.generateButton");

  return (
    <DetailCard
      title={t("pairDeviceCard.title")}
      subtitle={t("pairDeviceCard.subtitle", {
        name: target.assistantName ?? t("pairDeviceCard.subtitleFallbackName"),
      })}
    >
      <div className="flex flex-col gap-4">
        {showNoTunnelGuidance && (
          <Notice tone="info" title={t("pairDeviceCard.noTunnelTitle")}>
            {t("pairDeviceCard.noTunnelBody")}
          </Notice>
        )}
        <div className="flex flex-col gap-3">
          <Input
            label={t("pairDeviceCard.publicUrlLabel")}
            fullWidth
            placeholder={t("pairDeviceCard.publicUrlPlaceholder")}
            helperText={
              prefilledFromTunnel
                ? t("pairDeviceCard.publicUrlHelperTunnel")
                : t("pairDeviceCard.publicUrlHelper")
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

        <PendingPairingRequests
          base={target.base}
          onApproved={() => setDevicesRevalidateKey((key) => key + 1)}
        />

        {/* Poll while a code is live so an externally claimed pairing shows up.
            Gating at the render site also keeps the host `vellum devices`
            fetch from ever firing while the flag is off. */}
        {pairedDevicesUIOn && (
          <PairedDevicesSection
            pollWhilePairing={isReady && !pair.expired}
            revalidateKey={devicesRevalidateKey}
          />
        )}
      </div>
    </DetailCard>
  );
}
