import { useCallback, useEffect, useRef, useState } from "react";

import { getSelectedAssistant } from "@/lib/local-mode";
import {
  listPairedDevicesHost,
  revokePairedDeviceHost,
  type LocalPairedDeviceRecord,
} from "@/runtime/local-mode-host";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

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

export interface UsePairedDevicesOptions {
  /**
   * While true (a pairing code is live in the same card), refetch the list on
   * an interval so a device paired externally appears without a remount; one
   * final refresh runs when the flag drops.
   */
  pollWhilePairing?: boolean;
  /**
   * Bump to refetch once (e.g. after the sibling pending-request flow approves
   * a pairing); leaves any open confirm dialog alone.
   */
  revalidateKey?: number;
  /**
   * Whether the device rows are on screen. The activity refresh only runs
   * while they are: each refetch spawns a `vellum` subprocess through the
   * host seam, which is not worth paying to keep a hidden label fresh.
   */
  isExpanded?: boolean;
}

const PAIRING_POLL_INTERVAL_MS = 5_000;

/** Keeps the rendered activity label honest by resampling `lastUsedAt`. */
const ACTIVITY_REFRESH_INTERVAL_MS = 60_000;

/**
 * Drives the "Paired devices" accordion: fetches the selected assistant's
 * paired devices through the host seam and runs the confirm-then-revoke flow.
 * Any `{ ok: false }` list result (older app shells, unavailable hosts,
 * transport failures) collapses `devices` to `null` so the section degrades
 * silently instead of showing a broken state. The hook subscribes to the
 * assistant selection, so a switch while mounted refetches and closes any
 * open confirm dialog, but a revoke always targets the assistant the
 * rendered list was fetched for: device ids hash identically across
 * assistants, so a fresh selection read could silently revoke the wrong
 * assistant's pairing.
 */
export function usePairedDevices({
  pollWhilePairing = false,
  revalidateKey,
  isExpanded = false,
}: UsePairedDevicesOptions = {}): PairedDevicesController {
  const [list, setList] = useState<FetchedDeviceList | null>(null);
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

  const refresh = useCallback(
    (assistantId = getSelectedAssistant()?.assistantId) => {
      if (!assistantId) {
        return;
      }
      // Rows fetched for a different assistant must not render as the new
      // selection's while the fetch is in flight.
      setList((prev) =>
        prev && prev.assistantId !== assistantId ? null : prev,
      );
      const seq = ++fetchSeqRef.current;
      void listPairedDevicesHost(assistantId).then((result) => {
        if (!mountedRef.current || seq !== fetchSeqRef.current) {
          return;
        }
        setList(result.ok ? { assistantId, devices: result.devices } : null);
      });
    },
    [],
  );

  // Reactive selection seam: every switch path writes this slice. The
  // lockfile-active fallback covers a null slice (e.g. no explicit selection).
  const selectedAssistantId =
    useResolvedAssistantsStore.use.selectedAssistantId();
  const assistantId =
    selectedAssistantId ?? getSelectedAssistant()?.assistantId;

  useEffect(() => {
    // A selection switch invalidates any open confirm dialog.
    setConfirmTarget(null);
    setRevokeError(null);
    refresh(assistantId);
  }, [assistantId, refresh]);

  // A sibling approval paired a device: refetch on key change only, without
  // touching the dialog (the ref keeps this inert on selection re-renders).
  const lastRevalidateKeyRef = useRef(revalidateKey);
  useEffect(() => {
    if (revalidateKey === lastRevalidateKeyRef.current) {
      return;
    }
    lastRevalidateKeyRef.current = revalidateKey;
    refresh(assistantId);
  }, [revalidateKey, assistantId, refresh]);

  // Bounded revalidation while this card's own pairing code is live: an
  // external device claiming the code never signals this client, so poll
  // until the code is consumed/expired, then refresh once more to catch a
  // claim in the final window. Paused while a revoke is pending; the seq
  // guard makes any overlap safe.
  const wasPollingRef = useRef(false);
  useEffect(() => {
    if (pollWhilePairing && !isRevoking) {
      wasPollingRef.current = true;
      const id = setInterval(() => refresh(), PAIRING_POLL_INTERVAL_MS);
      return () => clearInterval(id);
    }
    if (!pollWhilePairing && wasPollingRef.current) {
      wasPollingRef.current = false;
      refresh();
    }
    return undefined;
  }, [pollWhilePairing, isRevoking, refresh]);

  // Each row's activity label is formatted from the `lastUsedAt` this fetch
  // sampled, so an expanded list ages one fixed instant and ends up claiming
  // a device is idle while it is still talking to the gateway. Resample on a
  // slow cadence, but only while the rows are actually expanded: a refetch
  // costs a `vellum` subprocess on the host, so a collapsed accordion must
  // not pay it. The pairing poll already refreshes faster than this, so stand
  // down whenever it is running.
  const hasDevices = (list?.devices.length ?? 0) > 0;
  useEffect(() => {
    if (!isExpanded || !hasDevices || pollWhilePairing || isRevoking) {
      return undefined;
    }
    const id = setInterval(() => refresh(), ACTIVITY_REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [isExpanded, hasDevices, pollWhilePairing, isRevoking, refresh]);

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
