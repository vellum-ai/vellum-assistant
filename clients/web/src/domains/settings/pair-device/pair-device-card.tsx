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
 * pairing routes ({@link useSupportsRemoteWebPairing}). The client-scoped
 * `web-remote-ingress` flag decides only whether this card renders; it gates
 * no pairing functionality.
 */
export function PairDeviceCard() {
  const { t } = useTranslation("settings");
  const target = resolvePairDeviceTarget();
  const supported = useSupportsRemoteWebPairing();
  const webRemoteIngressOn = useClientFeatureFlagStore.use.webRemoteIngress();
  const pair = usePairDevice(target?.base ?? null, target?.ingressUrl ?? null);
  const { copy, copied } = useCopyToClipboard({
    errorMessage: t("pairDeviceCard.copyFailed"),
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
    ? t("pairDeviceCard.generating")
    : isReady
      ? t("pairDeviceCard.generateNewCode")
      : t("pairDeviceCard.generatePairingQr");

  return (
    <DetailCard
      title={t("pairDeviceCard.title")}
      subtitle={t("pairDeviceCard.subtitle", {
        assistantName:
          target.assistantName ?? t("pairDeviceCard.thisAssistant"),
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
                ? t("pairDeviceCard.helperTextFromTunnel")
                : t("pairDeviceCard.helperTextManual")
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
