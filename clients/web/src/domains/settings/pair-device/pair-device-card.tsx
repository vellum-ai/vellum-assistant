import { useState } from "react";

import { ChevronDown } from "lucide-react";

import { Button } from "@vellumai/design-library/components/button";
import { Collapsible } from "@vellumai/design-library/components/collapsible";
import { Input } from "@vellumai/design-library/components/input";
import { Notice } from "@vellumai/design-library/components/notice";
import { cn } from "@vellumai/design-library/utils/cn";
import type { TunnelProviderName } from "@vellumai/service-contracts/ingress";

import { DetailCard } from "@/components/detail-card";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { Trans, useTranslation } from "@/i18n";
import { useSupportsRemoteWebPairing } from "@/lib/backwards-compat/remote-web-pairing-gate";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { handleNativeAnchorClick } from "@/utils/native-anchor";
import { docsUrl, routes } from "@/utils/routes";

import { CODE_CHIP_CLASS } from "./code-chip";
import { resolvePairDeviceTarget } from "./pair-device-client";
import { PairDeviceReady } from "./pair-device-ready";
import { PairedDevicesSection } from "./paired-devices-section";
import { PendingPairingRequests } from "./pending-pairing-requests";
import { useRelativeAgeTick } from "./relative-age";
import { TunnelRecheckButton } from "./tunnel-recheck-button";
import {
  statusCheckedAt,
  statusPublicBaseUrl,
  TunnelStatusRow,
  tunnelStartCommand,
  type TunnelStatusView,
} from "./tunnel-status-row";
import { usePairDevice } from "./use-pair-device";
import { useTunnelStatus } from "./use-tunnel-status";

/**
 * Named explicitly so the command does not depend on the CLI's default, and
 * typed against the shared registry so it can only name a provider the CLI
 * accepts.
 */
const TUNNEL_PROVIDER: TunnelProviderName = "tailscale";

/** The URL field's disclosure holds a single section. */
const URL_FIELD_SECTION = "public-url";

/**
 * Verdicts that doubt the address the card is about to advertise. Generate
 * softens on these rather than repeating the warning the status row prints,
 * and it stays enabled throughout: a false negative must not strand a user
 * whose address does work.
 */
const DOUBTED_KINDS = new Set<TunnelStatusView["kind"]>([
  "unpairable",
  "unreachable",
  "foreign",
]);

const TUNNEL_HELP_COMMAND = "vellum tunnel --help";

/** Public how-to for the whole tunnel-and-pair flow this card is one step of. */
const PAIRING_DOCS_URL = docsUrl(routes.docs.pairADevice);

/**
 * Settings card that pairs another device to this assistant without shell
 * commands, the UI equivalent of `vellum pair`. It mints and auto-approves a
 * device-code challenge against the host's loopback gateway and renders the
 * https pair URL as a QR with a copyable link and expiry countdown. It also
 * hosts the approval list for pairing requests minted elsewhere
 * ({@link PendingPairingRequests}).
 *
 * What the tunnel is doing comes from the daemon-side probe
 * ({@link useTunnelStatus}), which drives the status row, the first-run
 * notice, the URL field's prefill and whether it hides behind its disclosure,
 * and how much the Generate button insists. The probe re-runs on the
 * `app.resume` foreground edge, and on the re-check both the status row and
 * the first-run notice carry: the user opens the tunnel in a terminal beside
 * the window, which is not a foreground edge at all. Where the probe has no
 * verdict, because the assistant sits below the ingress-status version floor
 * or because the query gave up, the card falls back to the assistant's
 * recorded ingress URL and infers the empty state from the field.
 *
 * Rendered only in desktop/local mode against an on-machine gateway (the gate
 * lives in {@link resolvePairDeviceTarget}) whose assistant version serves the
 * pairing routes ({@link useSupportsRemoteWebPairing}). The client-scoped
 * `paired-devices-ui` flag decides only whether the paired-devices list +
 * revoke section renders inside the card; revocation itself stays available
 * via `vellum devices` on the host.
 */
export function PairDeviceCard() {
  const { t } = useTranslation("settings");
  const target = resolvePairDeviceTarget();
  const supported = useSupportsRemoteWebPairing();
  const pairedDevicesUIOn = useClientFeatureFlagStore.use.pairedDevicesUI();
  const tunnel = useTunnelStatus(supported && target !== null);
  // Whether the daemon's verdict is the card's source of truth right now. The
  // hook already folds every way the probe can fail to answer into
  // `unavailable`, the version gate included, so this is the whole condition;
  // re-deriving the gate here would only give it a second place to drift.
  const probeAnswered = tunnel.status.kind !== "unavailable";
  // The user starts the tunnel in a terminal and tabs back, so the foreground
  // edge is the re-check that matters most.
  useBusSubscription("app.resume", () => {
    tunnel.refresh();
  });
  // The card owns the tick behind the row's check age; the row stays
  // timer-free, per its own docstring.
  useRelativeAgeTick(statusCheckedAt(tunnel.status) !== null);
  // The address the daemon's current answer carries, if any. `null` while the
  // probe is still checking, so nothing downstream mistakes a fallback for a
  // reported address, and `null` for a stopped tunnel: its recorded address
  // serves nothing, so it is a command to re-run rather than one to advertise.
  const statusAddress =
    tunnel.status.kind === "stopped"
      ? null
      : statusPublicBaseUrl(tunnel.status);
  const pair = usePairDevice(
    target?.base ?? null,
    probeAnswered ? statusAddress : (target?.ingressUrl ?? null),
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

  if (!target || !supported) {
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
  // The first-run notice is where the user leaves to start a tunnel, so it
  // carries the re-check for coming back. Only a verdict can be re-checked:
  // below the version floor, or with the probe given up, `refresh` is a no-op.
  const offerFirstRunRecheck = showNoTunnelGuidance && probeAnswered;
  const tunnelWarns = probeAnswered && DOUBTED_KINDS.has(tunnel.status.kind);
  const buttonLabel = isMinting
    ? t("pairDeviceCard.generateButtonMinting")
    : isReady
      ? t("pairDeviceCard.generateButtonRegenerate")
      : tunnelWarns
        ? t("pairDeviceCard.generateButtonWarned")
        : t("pairDeviceCard.generateButton");
  // The URL field only hides behind its disclosure once the address it would
  // advertise is the one the daemon just reported. Until then it leads, so a
  // click can never mint a stale stored address the user never saw.
  const daemonHasAddress = probeAnswered && statusAddress !== null;
  // A rejected address opens the field too, or its error would report from
  // inside a closed disclosure.
  const urlFieldOpen = urlFieldOpened || pair.inputError !== null;

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
          <Notice
            tone="info"
            title={t("pairDeviceCard.noTunnelTitle")}
            actions={
              offerFirstRunRecheck ? (
                <TunnelRecheckButton
                  onRefresh={tunnel.refresh}
                  isRefreshing={tunnel.isRefreshing}
                  labelled
                />
              ) : undefined
            }
          >
            <div className="flex flex-col gap-2">
              <p>{t("pairDeviceCard.noTunnelWhy", { name: assistantLabel })}</p>
              <code
                className={cn(
                  CODE_CHIP_CLASS,
                  "w-fit max-w-full overflow-x-auto px-2.5 py-1.5",
                )}
              >
                {tunnelStartCommand(TUNNEL_PROVIDER, target.assistantName)}
              </code>
              <p>{t("pairDeviceCard.noTunnelNext")}</p>
              <p>
                <Trans
                  i18nKey="pairDeviceCard.noTunnelMore"
                  ns="settings"
                  values={{ command: TUNNEL_HELP_COMMAND }}
                  components={{
                    code: (
                      <code className={cn(CODE_CHIP_CLASS, "px-1.5 py-0.5")} />
                    ),
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
          assistantName={target.assistantName}
        />
        {/* With a reported address in hand the action leads and the field
            hides behind its disclosure. Without one the field leads and the
            action follows it, which is the card's layout until the probe
            answers with an address, and its whole layout before the probe. */}
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

        <a
          href={PAIRING_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => handleNativeAnchorClick(event, PAIRING_DOCS_URL)}
          className="self-start text-body-medium-default text-[var(--content-tertiary)] underline hover:text-[var(--content-default)]"
        >
          {t("pairDeviceCard.learnMore")}
        </a>
      </div>
    </DetailCard>
  );
}
