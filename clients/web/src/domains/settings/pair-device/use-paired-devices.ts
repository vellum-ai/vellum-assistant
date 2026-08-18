import { useCallback, useEffect, useRef, useState } from "react";

import { getSelectedAssistant } from "@/lib/local-mode";
import {
  listPairedDevicesHost,
  revokePairedDeviceHost,
  type LocalPairedDeviceRecord,
} from "@/runtime/local-mode-host";

function selectedAssistantId(): string | undefined {
  return getSelectedAssistant()?.assistantId;
}

export interface PairedDevicesController {
  /**
   * Paired devices for the selected assistant, or `null` when the list is
   * not loaded or unavailable. A refresh keeps the previous list rendered
   * until the new result lands.
   */
  devices: LocalPairedDeviceRecord[] | null;
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
}

/**
 * Drives the "Paired devices" accordion: fetches the selected assistant's
 * paired devices through the host seam and runs the confirm-then-revoke flow.
 * Any `{ ok: false }` list result (older app shells, unavailable hosts,
 * transport failures) collapses `devices` to `null` so the section degrades
 * silently instead of showing a broken state. The assistant id is read at
 * call time so every fetch and revoke targets the currently selected
 * assistant.
 */
export function usePairedDevices(): PairedDevicesController {
  const [devices, setDevices] = useState<LocalPairedDeviceRecord[] | null>(
    null,
  );
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
    const assistantId = selectedAssistantId();
    if (!assistantId) {
      return;
    }
    const seq = ++fetchSeqRef.current;
    void listPairedDevicesHost(assistantId).then((result) => {
      if (!mountedRef.current || seq !== fetchSeqRef.current) {
        return;
      }
      setDevices(result.ok ? result.devices : null);
    });
  }, []);

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
    const assistantId = selectedAssistantId();
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
  }, [confirmTarget, isRevoking, refresh]);

  return {
    devices,
    confirmTarget,
    isRevoking,
    revokeError,
    requestRevoke,
    cancelRevoke,
    confirmRevoke,
  };
}
