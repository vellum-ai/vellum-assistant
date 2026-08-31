import { useMemo, useState } from "react";

import { ChevronDown } from "lucide-react";

import { Button } from "@vellumai/design-library/components/button";
import { Collapsible } from "@vellumai/design-library/components/collapsible";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";

import { currentLocale, useTranslation, type TFunction } from "@/i18n";
import type { LocalPairedDeviceRecord } from "@/runtime/local-mode-host";

import { labelFromUserAgent } from "./device-label";
import { formatRelativeAge, useRelativeAgeTick } from "./relative-age";
import { usePairedDevices } from "./use-paired-devices";

/** Wider than the gateway's stamp debounce, so the label cannot flap. */
const ACTIVE_NOW_WINDOW_MS = 10 * 60 * 1000;

/** The accordion's single item; its presence in `value` means "expanded". */
const DEVICES_ITEM_VALUE = "paired-devices";

function shortHash(hashedDeviceId: string): string {
  return hashedDeviceId.slice(0, 12);
}

function platformLabel(t: TFunction<"settings">, platform: string): string {
  return platform
    ? platform.charAt(0).toUpperCase() + platform.slice(1)
    : t("pairedDevicesSection.platformUnknown");
}

interface ResolvedDeviceName {
  name: string;
  /** False only for the platform fallback; true for any reported identity. */
  isRealIdentity: boolean;
}

/**
 * Resolves a display name with precedence: a non-blank client-reported name,
 * else a browser/OS pair parsed from the stored pairing User-Agent, else the
 * platform label. Both raw inputs are attacker-controlled, but that only
 * matters for what the name says, not the boolean, which callers rely on to
 * decide whether the hash still needs to be shown inline.
 */
function deviceName(
  t: TFunction<"settings">,
  device: LocalPairedDeviceRecord,
): ResolvedDeviceName {
  if (
    typeof device.clientReportedName === "string" &&
    device.clientReportedName.trim() !== ""
  ) {
    return { name: device.clientReportedName, isRealIdentity: true };
  }

  const uaParts = labelFromUserAgent(device.pairingUserAgent);
  if (uaParts !== null) {
    const { browser, os } = uaParts;
    if (browser !== null && os !== null) {
      return {
        name: t("pairedDevicesSection.browserOnOs", { browser, os }),
        isRealIdentity: true,
      };
    }
    // Exactly one part identified: a bare proper noun needs no ICU key.
    return { name: browser ?? os ?? "", isRealIdentity: true };
  }

  return { name: platformLabel(t, device.platform), isRealIdentity: false };
}

function formatDeviceDate(
  t: TFunction<"settings">,
  epochMs: number | null,
): string {
  return epochMs === null
    ? t("pairedDevicesSection.dateUnknown")
    : new Date(epochMs).toLocaleDateString(currentLocale());
}

/**
 * The pairing date, plus a relative activity label once the device has been
 * seen. Anything inside the window collapses to "Active now", since the
 * gateway debounces its stamp and a finer reading would be precision the value
 * does not have. A device never seen gets no activity clause at all.
 */
function activityLine(
  t: TFunction<"settings">,
  device: LocalPairedDeviceRecord,
): string {
  const paired = formatDeviceDate(t, device.issuedAt);
  if (device.lastUsedAt === null) {
    return t("pairedDevicesSection.pairedLine", { paired });
  }
  return Date.now() - device.lastUsedAt <= ACTIVE_NOW_WINDOW_MS
    ? t("pairedDevicesSection.pairedActiveLine", { paired })
    : t("pairedDevicesSection.pairedAndUsedLine", {
        paired,
        lastUsed: formatRelativeAge(device.lastUsedAt),
      });
}

interface PairedDevicesSectionProps {
  /** True while the parent card has a live pairing code; drives list polling. */
  pollWhilePairing?: boolean;
  /** Bump to refetch the list (a sibling approval just paired a device). */
  revalidateKey?: number;
}

/**
 * Accordion listing the devices paired to the local assistant, with a
 * destructive per-device Revoke behind a confirm dialog. Renders nothing
 * unless the host reports one or more devices, so older app shells, host
 * failures, and empty lists leave the Pair a device card exactly as it is.
 * The host machine's own credential row is labeled "This machine" with Revoke
 * disabled; revoking it would lock the host out of its own assistant.
 */
export function PairedDevicesSection({
  pollWhilePairing = false,
  revalidateKey,
}: PairedDevicesSectionProps = {}) {
  const { t } = useTranslation("settings");
  // The accordion mounts collapsed, and refreshing the list costs a host
  // subprocess, so the controller only resamples once the rows are on screen.
  const [isExpanded, setIsExpanded] = useState(false);
  const controller = usePairedDevices({
    pollWhilePairing,
    revalidateKey,
    isExpanded,
  });
  const { devices, confirmTarget } = controller;

  // Activity labels are formatted from a fixed instant, and the list only
  // refetches on its own while pairing, so without a tick they freeze.
  useRelativeAgeTick(devices?.some((d) => d.lastUsedAt !== null) ?? false);

  // Live devices first, never-seen last, so revoke candidates cluster at the
  // bottom. The controller owns `devices`, so the sort runs on a copy.
  const orderedDevices = useMemo(
    () =>
      devices === null
        ? null
        : [...devices].sort(
            (a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0),
          ),
    [devices],
  );

  if (orderedDevices === null || orderedDevices.length === 0) {
    return null;
  }

  return (
    <>
      <Collapsible.Root
        type="multiple"
        value={isExpanded ? [DEVICES_ITEM_VALUE] : []}
        onValueChange={(open) =>
          setIsExpanded(open.includes(DEVICES_ITEM_VALUE))
        }
      >
        <Collapsible.Item value={DEVICES_ITEM_VALUE}>
          <Collapsible.Trigger className="group flex w-full items-center justify-between gap-3">
            <span className="text-body-medium-default text-[var(--content-secondary)]">
              {t("pairedDevicesSection.title", {
                count: orderedDevices.length,
              })}
            </span>
            <ChevronDown className="h-4 w-4 shrink-0 text-[var(--content-tertiary)] transition-transform group-data-[state=open]:rotate-180" />
          </Collapsible.Trigger>
          <Collapsible.Content>
            <div className="mt-3 flex flex-col gap-3">
              {orderedDevices.map((device) => {
                const resolved = deviceName(t, device);
                return (
                  <div
                    key={device.hashedDeviceId}
                    className="flex items-center justify-between gap-3"
                  >
                    <div className="flex min-w-0 flex-col">
                      <span className="flex min-w-0 items-baseline gap-1 text-body-medium-default text-[var(--content-secondary)]">
                        <span
                          className="min-w-0 truncate"
                          title={
                            resolved.isRealIdentity
                              ? device.hashedDeviceId
                              : undefined
                          }
                        >
                          {resolved.name}
                        </span>
                        {!resolved.isRealIdentity && (
                          <span
                            className="shrink-0 font-mono text-[var(--content-tertiary)]"
                            title={device.hashedDeviceId}
                          >
                            {shortHash(device.hashedDeviceId)}
                          </span>
                        )}
                        {device.isCurrentHost && (
                          // Kept separate from the name span above: a device
                          // that reports itself as "This machine" cannot
                          // spoof this marker, which is stamped by the host.
                          <span className="shrink-0 text-[var(--content-tertiary)]">
                            {`· ${t("pairedDevicesSection.thisMachine")}`}
                          </span>
                        )}
                      </span>
                      <span className="text-body-medium-default text-[var(--content-tertiary)]">
                        {activityLine(t, device)}
                      </span>
                    </div>
                    <Button
                      variant="dangerOutline"
                      size="compact"
                      className="shrink-0"
                      disabled={device.isCurrentHost === true}
                      title={
                        device.isCurrentHost
                          ? t("pairedDevicesSection.hostRevokeDisabledTitle")
                          : undefined
                      }
                      onClick={() => controller.requestRevoke(device)}
                    >
                      {t("pairedDevicesSection.revokeButton")}
                    </Button>
                  </div>
                );
              })}
            </div>
          </Collapsible.Content>
        </Collapsible.Item>
      </Collapsible.Root>
      <ConfirmDialog
        open={confirmTarget !== null}
        title={t("pairedDevicesSection.confirmTitle")}
        message={
          confirmTarget && (
            <>
              {t("pairedDevicesSection.confirmMessageNamed", {
                name: deviceName(t, confirmTarget).name,
                hash: shortHash(confirmTarget.hashedDeviceId),
              })}
              {controller.revokeError && (
                <span className="mt-2 block text-[var(--system-negative-strong)]">
                  {controller.revokeError}
                </span>
              )}
            </>
          )
        }
        confirmLabel={t("pairedDevicesSection.revokeButton")}
        destructive
        isPending={controller.isRevoking}
        onConfirm={controller.confirmRevoke}
        onCancel={controller.cancelRevoke}
      />
    </>
  );
}
