import { ChevronDown } from "lucide-react";

import { Button } from "@vellumai/design-library/components/button";
import { Collapsible } from "@vellumai/design-library/components/collapsible";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";

import { usePairedDevices } from "./use-paired-devices";

function shortHash(hashedDeviceId: string): string {
  return hashedDeviceId.slice(0, 12);
}

function platformLabel(platform: string): string {
  return platform
    ? platform.charAt(0).toUpperCase() + platform.slice(1)
    : "Unknown";
}

function formatDeviceDate(epochMs: number | null): string {
  return epochMs === null ? "unknown" : new Date(epochMs).toLocaleDateString();
}

const HOST_REVOKE_DISABLED_TITLE =
  "This is this machine's own credential; revoking it would lock the host out of the assistant.";

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
  const controller = usePairedDevices({ pollWhilePairing, revalidateKey });
  const { devices, confirmTarget } = controller;

  if (devices === null || devices.length === 0) {
    return null;
  }

  return (
    <>
      <Collapsible.Root type="multiple">
        <Collapsible.Item value="paired-devices">
          <Collapsible.Trigger className="group flex w-full items-center justify-between gap-3">
            <span className="text-body-medium-default text-[var(--content-secondary)]">
              {`Paired devices (${devices.length})`}
            </span>
            <ChevronDown className="h-4 w-4 shrink-0 text-[var(--content-tertiary)] transition-transform group-data-[state=open]:rotate-180" />
          </Collapsible.Trigger>
          <Collapsible.Content>
            <div className="mt-3 flex flex-col gap-3">
              {devices.map((device) => (
                <div
                  key={device.hashedDeviceId}
                  className="flex items-center justify-between gap-3"
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="text-body-medium-default text-[var(--content-secondary)]">
                      {platformLabel(device.platform)}{" "}
                      <span
                        className="font-mono text-[var(--content-tertiary)]"
                        title={device.hashedDeviceId}
                      >
                        {shortHash(device.hashedDeviceId)}
                      </span>
                      {device.isCurrentHost && (
                        <span className="text-[var(--content-tertiary)]">
                          {" · This machine"}
                        </span>
                      )}
                    </span>
                    <span className="text-body-medium-default text-[var(--content-tertiary)]">
                      {`Paired ${formatDeviceDate(device.issuedAt)} · Last used ${formatDeviceDate(device.lastUsedAt)}`}
                    </span>
                  </div>
                  <Button
                    variant="dangerOutline"
                    size="compact"
                    className="shrink-0"
                    disabled={device.isCurrentHost === true}
                    title={
                      device.isCurrentHost
                        ? HOST_REVOKE_DISABLED_TITLE
                        : undefined
                    }
                    onClick={() => controller.requestRevoke(device)}
                  >
                    Revoke
                  </Button>
                </div>
              ))}
            </div>
          </Collapsible.Content>
        </Collapsible.Item>
      </Collapsible.Root>
      <ConfirmDialog
        open={confirmTarget !== null}
        title="Revoke this device?"
        message={
          confirmTarget && (
            <>
              The {platformLabel(confirmTarget.platform)} device{" "}
              {shortHash(confirmTarget.hashedDeviceId)} loses access to this
              assistant. Its access tokens are invalidated immediately; that
              device must be paired again from this machine to reconnect.
              {controller.revokeError && (
                <span className="mt-2 block text-[var(--system-negative-strong)]">
                  {controller.revokeError}
                </span>
              )}
            </>
          )
        }
        confirmLabel="Revoke"
        destructive
        isPending={controller.isRevoking}
        onConfirm={controller.confirmRevoke}
        onCancel={controller.cancelRevoke}
      />
    </>
  );
}
