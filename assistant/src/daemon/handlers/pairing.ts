import { cleanupPairingState } from "../../runtime/routes/pairing-routes.js";
import {
  approveDevice,
  clearAllDevices,
  listDevices,
  removeDevice,
} from "../approved-devices-store.js";
import type {
  ApprovedDeviceRemove,
  PairingApprovalResponse,
} from "../message-protocol.js";
import type { PairingStore } from "../pairing-store.js";
import { defineHandlers, type HandlerContext, log } from "./shared.js";

/** Module-level reference set by the daemon server at startup. */
let pairingStoreRef: PairingStore | null = null;
let bearerTokenRef: string | undefined;

export function initPairingHandlers(
  store: PairingStore,
  bearerToken: string | undefined,
): void {
  pairingStoreRef = store;
  bearerTokenRef = bearerToken;
}

function handlePairingApprovalResponse(
  msg: PairingApprovalResponse,
  _ctx: HandlerContext,
): void {
  if (!pairingStoreRef) {
    log.warn("Pairing store not initialized");
    return;
  }

  const entry = pairingStoreRef.get(msg.pairingRequestId);
  if (!entry) {
    log.warn(
      { pairingRequestId: msg.pairingRequestId },
      "Pairing request not found for approval response",
    );
    return;
  }

  // Idempotent: if already approved/denied, just re-broadcast the current status
  if (entry.status === "approved" || entry.status === "denied") {
    log.info(
      { pairingRequestId: msg.pairingRequestId, status: entry.status },
      "Duplicate approval response, no-op",
    );
    return;
  }

  if (msg.decision === "deny") {
    pairingStoreRef.deny(msg.pairingRequestId);
    cleanupPairingState(msg.pairingRequestId);
    log.info(
      { pairingRequestId: msg.pairingRequestId },
      "Pairing request denied",
    );
    return;
  }

  // approve_once or always_allow
  if (!bearerTokenRef) {
    log.error("Cannot approve pairing: no bearer token configured");
    return;
  }

  pairingStoreRef.approve(msg.pairingRequestId, bearerTokenRef);
  log.info(
    { pairingRequestId: msg.pairingRequestId, decision: msg.decision },
    "Pairing request approved",
  );

  // If always_allow, persist the device to the allowlist
  if (msg.decision === "always_allow" && entry.hashedDeviceId) {
    approveDevice(entry.hashedDeviceId, entry.deviceName ?? "Unknown Device");
  }
}

function handleApprovedDevicesList(ctx: HandlerContext): void {
  const devices = listDevices();
  ctx.send({
    type: "approved_devices_list_response",
    devices,
  });
}

function handleApprovedDeviceRemove(
  msg: ApprovedDeviceRemove,
  ctx: HandlerContext,
): void {
  const success = removeDevice(msg.hashedDeviceId);
  ctx.send({
    type: "approved_device_remove_response",
    success,
  });
  log.info(
    { hashedDeviceId: msg.hashedDeviceId, success },
    "Device removal requested via IPC",
  );
}

function handleApprovedDevicesClear(_ctx: HandlerContext): void {
  clearAllDevices();
  log.info("All approved devices cleared via IPC");
}

export const pairingHandlers = defineHandlers({
  pairing_approval_response: handlePairingApprovalResponse,
  approved_devices_list: (_msg, ctx) => handleApprovedDevicesList(ctx),
  approved_device_remove: handleApprovedDeviceRemove,
  approved_devices_clear: (_msg, ctx) => handleApprovedDevicesClear(ctx),
});
