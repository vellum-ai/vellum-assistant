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
   * The most recently fetched paired-device list, or `null` when the list is
   * not loaded or unavailable. A same-assistant refresh keeps the previous
   * list rendered until the new result lands.
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

interface FetchedDeviceList {
  /** Assistant the list was fetched for; revokes always target this id. */
  assistantId: string;
  devices: LocalPairedDeviceRecord[];
}

/**
 * Drives the "Paired devices" accordion: fetches the selected assistant's
 * paired devices through the host seam and runs the confirm-then-revoke flow.
 * Any `{ ok: false }` list result (older app shells, unavailable hosts,
 * transport failures) collapses `devices` to `null` so the section degrades
 * silently instead of showing a broken state. Each fetch reads the selected
 * assistant, but a revoke always targets the assistant the rendered list was
 * fetched for: device ids hash identically across assistants, so a fresh
 * selection read could silently revoke the wrong assistant's pairing.
 */
export function usePairedDevices(): PairedDevicesController {
  const [list, setList] = useState<FetchedDeviceList | null>(null);
  const [confirmTarget, setConfirmTarget] =
    useState<LocalPairedDeviceRecord | null>(null);
  const [isRevoking, setIsRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  // Host calls aren't abortable, so guard setState after unmount (and against
  // out-of-order responses) with a mounted flag + request sequence.
  const mountedRef = useRef(true);
  const fetchSeqRef = useRef(0);
  // Mirrors `list?.assistantId` so the stable `refresh` callback can detect a
  // selection change without depending on state (which would refetch-loop the
  // mount effect).
  const listAssistantIdRef = useRef<string | null>(null);

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
    if (
      listAssistantIdRef.current !== null &&
      listAssistantIdRef.current !== assistantId
    ) {
      // The rendered rows belong to a different assistant: drop them and any
      // pending confirmation instead of presenting them as the new
      // selection's.
      listAssistantIdRef.current = null;
      setList(null);
      setConfirmTarget(null);
      setRevokeError(null);
    }
    const seq = ++fetchSeqRef.current;
    void listPairedDevicesHost(assistantId).then((result) => {
      if (!mountedRef.current || seq !== fetchSeqRef.current) {
        return;
      }
      listAssistantIdRef.current = result.ok ? assistantId : null;
      setList(result.ok ? { assistantId, devices: result.devices } : null);
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
    if (!list || !confirmTarget || isRevoking) {
      return;
    }
    setIsRevoking(true);
    setRevokeError(null);
    void revokePairedDeviceHost(
      list.assistantId,
      confirmTarget.hashedDeviceId,
    ).then((result) => {
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
    });
  }, [list, confirmTarget, isRevoking, refresh]);

  return {
    devices: list?.devices ?? null,
    confirmTarget,
    isRevoking,
    revokeError,
    requestRevoke,
    cancelRevoke,
    confirmRevoke,
  };
}
