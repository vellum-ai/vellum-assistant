import type {
  NotificationIdentity,
  NotificationNameProvenance,
  NotificationPresentation,
} from "@vellumai/ipc-contract";

/** Routing metadata carried by native, Electron, and browser notifications. */
export interface NotificationTapPayload {
  conversationId?: string;
  sourceEventName: string;
  deliveryId?: string;
  identity?: NotificationIdentity;
  presentation?: NotificationPresentation;
  nameProvenance?: NotificationNameProvenance;
  suppressGroupTitle?: boolean;
}

export type NotificationTapHandler = (
  payload: NotificationTapPayload,
) => void | Promise<void>;

const MAX_PENDING_TAPS = 32;

let tapHandler: NotificationTapHandler | null = null;
const pendingTaps: NotificationTapPayload[] = [];
let drainingTaps = false;
let tapGeneration = 0;

function drainPendingTaps(): void {
  if (drainingTaps || !tapHandler) {
    return;
  }
  drainingTaps = true;
  const generation = tapGeneration;
  void (async () => {
    try {
      while (generation === tapGeneration && pendingTaps.length > 0) {
        const handler = tapHandler;
        if (!handler) {
          break;
        }
        const payload = pendingTaps.shift();
        if (payload) {
          try {
            await handler(payload);
          } catch {
            // A rejected handler must not strand later tap navigation.
          }
        }
      }
    } finally {
      if (generation !== tapGeneration) {
        return;
      }
      drainingTaps = false;
      if (pendingTaps.length > 0) {
        drainPendingTaps();
      }
    }
  })();
}

/**
 * Deliver a tap to the registered app handler. A bounded queue retains taps
 * that arrive while the authenticated React tree is still mounting.
 */
export function dispatchNotificationTap(payload: NotificationTapPayload): void {
  if (pendingTaps.length === MAX_PENDING_TAPS) {
    pendingTaps.shift();
  }
  pendingTaps.push(payload);
  drainPendingTaps();
}

/** Register or replace the process-local tap handler and drain cold-start taps. */
export function registerNotificationTapHandler(
  handler: NotificationTapHandler,
): void {
  tapHandler = handler;
  drainPendingTaps();
}

export function __resetNotificationTapsForTests(): void {
  tapGeneration += 1;
  tapHandler = null;
  pendingTaps.length = 0;
  drainingTaps = false;
}
