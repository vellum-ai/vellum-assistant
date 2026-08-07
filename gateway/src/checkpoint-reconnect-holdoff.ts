const CHECKPOINT_RECONNECT_HOLDOFF_MS = 60_000;

let reconnectHoldoffUntil = 0;

/** Block new external reconnects while a pod checkpoint is pending. */
export function beginCheckpointReconnectHoldoff(): void {
  reconnectHoldoffUntil = Math.max(
    reconnectHoldoffUntil,
    Date.now() + CHECKPOINT_RECONNECT_HOLDOFF_MS,
  );
}

/** Resume external reconnects after system wake. */
export function clearCheckpointReconnectHoldoff(): void {
  reconnectHoldoffUntil = 0;
}

export function isCheckpointReconnectHoldoffActive(): boolean {
  return checkpointReconnectHoldoffRemainingMs() > 0;
}

export function checkpointReconnectHoldoffRemainingMs(): number {
  return Math.max(0, reconnectHoldoffUntil - Date.now());
}
