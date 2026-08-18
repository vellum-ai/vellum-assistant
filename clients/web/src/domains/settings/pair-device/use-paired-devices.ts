import { useCallback, useEffect, useRef, useState } from "react";

import { getSelectedAssistant } from "@/lib/local-mode";
import {
  listPairedDevicesHost,
  revokePairedDeviceHost,
  type LocalPairedDeviceRecord,
} from "@/runtime/local-mode-host";

export type PairedDevicesPhase =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; devices: LocalPairedDeviceRecord[] }
  | { kind: "unavailable" };

export interface PairedDevicesController {
  phase: PairedDevicesPhase;
  /** Device awaiting revoke confirmation, or `null` when no dialog is open. */
  confirmTarget: LocalPairedDeviceRecord | null;
  /** Whether a revoke request is in flight. */
  isRevoking: boolean;
  /** Inline failure line for the confirm dialog, or `null`. */
  revokeError: string | null;
  /** Open the revoke confirmation for a device. */
  requestRevoke: (device: LocalPairedDeviceRecord) => void;
  /** Close the confirmation without revoking. */
  cancelRevoke: () => void;
  /** Revoke {@link confirmTarget}'s tokens; refreshes the list on success. */
  confirmRevoke: () => void;
  /** Re-fetch the device list from the host. */
  refresh: () => void;
}

/**
 * Drives the "Paired devices" accordion: fetches the selected assistant's
 * paired devices through the host seam and runs the confirm-then-revoke flow.
 * Any `{ ok: false }` list result (older app shells, unavailable hosts,
 * transport failures) collapses to the `unavailable` phase so the section
 * degrades silently instead of showing a broken state.
 */
export function usePairedDevices(enabled: boolean): PairedDevicesController {
  const [assistantId] = useState(
    () => getSelectedAssistant()?.assistantId ?? null,
  );
  const [phase, setPhase] = useState<PairedDevicesPhase>({ kind: "idle" });
  const [confirmTarget, setConfirmTarget] =
    useState<LocalPairedDeviceRecord | null>(null);
  const [isRevoking, setIsRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  // Host calls aren't abortable, so guard setState after unmount (and against
  // out-of-order responses) with a mounted flag + request sequence.
  const mountedRef = useRef(true);
  const fetchSeqRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(() => {
    if (!enabled || !assistantId) {
      return;
    }
    const seq = ++fetchSeqRef.current;
    setPhase({ kind: "loading" });
    void listPairedDevicesHost(assistantId).then((result) => {
      if (!mountedRef.current || seq !== fetchSeqRef.current) {
        return;
      }
      setPhase(
        result.ok
          ? { kind: "ready", devices: result.devices }
          : { kind: "unavailable" },
      );
    });
  }, [enabled, assistantId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const requestRevoke = useCallback((device: LocalPairedDeviceRecord) => {
    setRevokeError(null);
    setConfirmTarget(device);
  }, []);

  const cancelRevoke = useCallback(() => {
    setConfirmTarget(null);
    setRevokeError(null);
  }, []);

  const confirmRevoke = useCallback(() => {
    if (!assistantId || !confirmTarget || isRevoking) {
      return;
    }
    setIsRevoking(true);
    setRevokeError(null);
    void revokePairedDeviceHost(assistantId, confirmTarget.hashedDeviceId).then(
      (result) => {
        if (!mountedRef.current) {
          return;
        }
        setIsRevoking(false);
        if (result.ok) {
          setConfirmTarget(null);
          refresh();
        } else {
          setRevokeError(result.error);
        }
      },
    );
  }, [assistantId, confirmTarget, isRevoking, refresh]);

  return {
    phase,
    confirmTarget,
    isRevoking,
    revokeError,
    requestRevoke,
    cancelRevoke,
    confirmRevoke,
    refresh,
  };
}
