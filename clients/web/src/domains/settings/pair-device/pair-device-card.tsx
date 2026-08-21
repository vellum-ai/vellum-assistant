import { useState } from "react";

import { ChevronDown } from "lucide-react";

import { Button } from "@vellumai/design-library/components/button";
import { Collapsible } from "@vellumai/design-library/components/collapsible";
import { Input } from "@vellumai/design-library/components/input";
import { Notice } from "@vellumai/design-library/components/notice";
import { cn } from "@vellumai/design-library/utils/cn";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { DetailCard } from "@/components/detail-card";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { Trans, useTranslation } from "@/i18n";
import { useSupportsIngressStatus } from "@/lib/backwards-compat/ingress-status-gate";
import { useSupportsRemoteWebPairing } from "@/lib/backwards-compat/remote-web-pairing-gate";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";

import { resolvePairDeviceTarget } from "./pair-device-client";
import { PairDeviceReady } from "./pair-device-ready";
import { PairedDevicesSection } from "./paired-devices-section";
import { PendingPairingRequests } from "./pending-pairing-requests";
import { statusPublicBaseUrl, TunnelStatusRow } from "./tunnel-status-row";
import { usePairDevice } from "./use-pair-device";
import { useTunnelStatus } from "./use-tunnel-status";

/** Names a provider explicitly: the CLI's `vellum` default is not implemented. */
const TUNNEL_COMMAND = "vellum tunnel --provider tailscale";
const TUNNEL_HELP_COMMAND = "vellum tunnel --help";

/** The URL field's disclosure holds a single section. */
const URL_FIELD_SECTION = "public-url";

const CODE_CLASS =
  "rounded-md bg-[var(--surface-active)] text-body-small-default text-[color:var(--content-primary)]";

/**
 * Settings card that pairs another device to this assistant without shell
 * commands —
 * the UI equivalent of `vellum pair --qr`. It mints and auto-approves a
 * device-code challenge against the host's loopback gateway and renders the
 * https pair URL as a QR with a copyable link and expiry countdown. It also
 * hosts the approval list for pairing requests minted elsewhere
 * ({@link PendingPairingRequests}).
 *
 * What the tunnel is doing comes from the daemon-side probe
 * ({@link useTunnelStatus}), which drives the status row, the first-run
 * notice, the URL field's prefill and whether it hides behind its disclosure,
 * and how much the Generate button insists. The probe re-runs on the
 * `app.resume` foreground edge. Where that probe has no verdict, because the
 * assistant sits below {@link useSupportsIngressStatus}'s floor or because the
 * query gave up, the card falls back to the assistant's recorded ingress URL
 * and infers the empty state from the field.
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
  const assistantId = useActiveAssistantId();
  const probesTunnel = useSupportsIngressStatus(assistantId);
  const surfaceEnabled = supported && webRemoteIngressOn;
  const tunnel = useTunnelStatus(surfaceEnabled && target !== null);
  // Whether the daemon's verdict is the card's source of truth right now. An
  // assistant that cannot be asked, and a probe that came back with nothing,
  // both leave the card on its pre-probe behavior below.
  const probeAnswered = probesTunnel && tunnel.status.kind !== "unavailable";
  // The user starts the tunnel in a terminal and tabs back, so the foreground
  // edge is the re-check that matters most.
  useBusSubscription("app.resume", () => {
    tunnel.refresh();
  });
  const pair = usePairDevice(
    target?.base ?? null,
    probeAnswered
      ? statusPublicBaseUrl(tunnel.status)
      : (target?.ingressUrl ?? null),
  );
  // Bumped when the pending-request flow pairs a device, so the device list
  // below refetches without waiting for a live-code poll.
  const [devicesRevalidateKey, setDevicesRevalidateKey] = useState(0);
  // The user taking the URL field over, by opening its disclosure or typing in
  // it. Sticky, so a verdict arriving afterwards cannot collapse the field out
  // from under them.
  const [urlFieldOpened, setUrlFieldOpened] = useState(false);
  const { copy, copied } = useCopyToClipboard({
    errorMessage: t("pairDeviceCard.copyError"),
  });

  if (!target || !surfaceEnabled) {
    return null;
  }

  const assistantLabel =
    target.assistantName ?? t("pairDeviceCard.subtitleFallbackName");
  const { phase } = pair;
  const isMinting = phase.kind === "minting";
  const isReady = phase.kind === "ready";
  const prefilledFromTunnel = pair.prefillSource === "tunnel";
  // Honest empty state: the daemon's verdict where the probe answers, and
  // where it does not, the field-derived inference (no reported URL, no
  // stored value, field still empty). Advanced users can still type an
  // address into the field below either way.
  const showNoTunnelGuidance = probeAnswered
    ? tunnel.status.kind === "unconfigured"
    : pair.prefillSource === "none" && pair.publicBaseUrl.trim() === "";
  // The probe doubts the address. The status row already says so, so the
  // button softens to match instead of repeating the warning.
  const tunnelWarns =
    probeAnswered &&
    (tunnel.status.kind === "unreachable" || tunnel.status.kind === "foreign");
  const buttonLabel = isMinting
    ? t("pairDeviceCard.generateButtonMinting")
    : isReady
      ? t("pairDeviceCard.generateButtonRegenerate")
      : tunnelWarns
        ? t("pairDeviceCard.generateButtonWarned")
        : t("pairDeviceCard.generateButton");
  // The URL field sits behind a disclosure wherever the daemon has an address
  // for this assistant, or is still finding one, and stays in the open where
  // it has none (no tunnel, a stopped one, no verdict at all): typing one is
  // then the only way through.
  const daemonHasAddress =
    probeAnswered &&
    tunnel.status.kind !== "unconfigured" &&
    tunnel.status.kind !== "stopped";
  // A rejected address opens the field too, or its error would report from
  // inside a closed disclosure.
  const urlFieldOpen = urlFieldOpened || pair.inputError !== null;

  // Never disabled on the probe's word: a false negative must not strand a
  // user whose address does work.
  const generateButton = (
    <Button
      variant={tunnelWarns ? "outlined" : "primary"}
      className="self-start"
      disabled={isMinting || pair.publicBaseUrl.trim() === ""}
      onClick={pair.generate}
    >
      {buttonLabel}
    </Button>
  );

  const urlField = (
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
      onChange={(event) => {
        setUrlFieldOpened(true);
        pair.setPublicBaseUrl(event.target.value);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          pair.generate();
        }
      }}
    />
  );

  return (
    <DetailCard
      title={t("pairDeviceCard.title")}
      subtitle={t("pairDeviceCard.subtitle", { name: assistantLabel })}
    >
      <div className="flex flex-col gap-4">
        {showNoTunnelGuidance && (
          <Notice tone="info" title={t("pairDeviceCard.noTunnelTitle")}>
            <div className="flex flex-col gap-2">
              <p>{t("pairDeviceCard.noTunnelWhy", { name: assistantLabel })}</p>
              <code
                className={cn(
                  CODE_CLASS,
                  "w-fit max-w-full overflow-x-auto px-2.5 py-1.5",
                )}
              >
                {TUNNEL_COMMAND}
              </code>
              <p>{t("pairDeviceCard.noTunnelNext")}</p>
              <p>
                <Trans
                  i18nKey="pairDeviceCard.noTunnelMore"
                  ns="settings"
                  values={{ command: TUNNEL_HELP_COMMAND }}
                  components={{
                    code: <code className={cn(CODE_CLASS, "px-1.5 py-0.5")} />,
                  }}
                />
              </p>
            </div>
          </Notice>
        )}
        <TunnelStatusRow
          status={tunnel.status}
          onRefresh={tunnel.refresh}
          isRefreshing={tunnel.isRefreshing}
        />
        {/* With an address in hand the action leads and the field hides
            behind its disclosure. Without one the field leads and the action
            follows it, which is the card's whole layout before the probe. */}
        <div className="flex flex-col gap-3">
          {daemonHasAddress ? (
            <>
              {generateButton}
              <Collapsible.Root
                type="single"
                collapsible
                value={urlFieldOpen ? URL_FIELD_SECTION : ""}
                onValueChange={(value) =>
                  setUrlFieldOpened(value === URL_FIELD_SECTION)
                }
              >
                <Collapsible.Item value={URL_FIELD_SECTION}>
                  <Collapsible.Trigger className="group flex w-full items-center justify-between gap-3">
                    <span className="text-body-medium-default text-[var(--content-secondary)]">
                      {t("pairDeviceCard.publicUrlDisclosure")}
                    </span>
                    <ChevronDown className="h-4 w-4 shrink-0 text-[var(--content-tertiary)] transition-transform group-data-[state=open]:rotate-180" />
                  </Collapsible.Trigger>
                  <Collapsible.Content>
                    <div className="mt-3">{urlField}</div>
                  </Collapsible.Content>
                </Collapsible.Item>
              </Collapsible.Root>
            </>
          ) : (
            <>
              {urlField}
              {generateButton}
            </>
          )}
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
