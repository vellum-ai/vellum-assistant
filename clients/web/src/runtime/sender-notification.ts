/**
 * Version-skew-safe bridge to the iOS process-local notification owner.
 *
 * A live web bundle can run inside an older installed shell, so every native
 * method is gated first by platform, plugin registration, contract version,
 * and the capability it needs. Once `post` is invoked, a rejected or timed-out
 * bridge is ambiguous: native code may still own and deliver the request. The
 * result is therefore `unknown`, never permission to schedule a second banner.
 */

import { Capacitor, registerPlugin } from "@capacitor/core";
import {
  type NotificationDeliveryIdentifiers,
  type NotificationDeliveryResult,
  type NotificationIdentity,
  type NotificationNameProvenance,
  type NotificationPresentation,
  type NotificationSender,
  type PrepareNotificationIdentityPayload,
  type ResetNotificationIdentitiesPayload,
} from "@vellumai/ipc-contract";

import { setNotificationIdentityNativeAdapter } from "@/runtime/notification-avatar";

const PLUGIN_NAME = "SenderNotification";
const CONTRACT_VERSION = 1;
const PREPARED_IDENTITY_CAPABILITY = "preparedIdentity";
const SINGLE_POST_OWNER_CAPABILITY = "singlePostOwner";
const DELIVERY_STATUS_CAPABILITY = "deliveryStatus";
const DEFAULT_WATCHDOG_MS = 2_000;

interface SenderNotificationCapabilities {
  version?: unknown;
  capabilities?: unknown;
}

export interface SenderNotificationPostRequest
  extends NotificationDeliveryIdentifiers {
  id: number;
  title: string;
  body: string;
  extra: object;
  actionTypeId?: string;
  presentation: NotificationPresentation;
  identity?: NotificationIdentity;
  name?: string;
  nameProvenance?: NotificationNameProvenance;
  suppressGroupTitle?: boolean;
  sender?: NotificationSender;
}

interface SenderNotificationPlugin {
  getCapabilities(): Promise<SenderNotificationCapabilities>;
  prepare(
    payload: PrepareNotificationIdentityPayload,
  ): Promise<{ ok?: boolean }>;
  reset(
    payload: ResetNotificationIdentitiesPayload,
  ): Promise<{ ok?: boolean }>;
  post(
    payload: SenderNotificationPostRequest,
  ): Promise<NotificationDeliveryResult>;
  status(
    payload: NotificationDeliveryIdentifiers,
  ): Promise<NotificationDeliveryResult>;
}

const SenderNotification =
  registerPlugin<SenderNotificationPlugin>(PLUGIN_NAME);

let watchdogMs = DEFAULT_WATCHDOG_MS;
let capabilityRequest: Promise<ReadonlySet<string> | null> | null = null;

function isBridgeRegistered(): boolean {
  return (
    Capacitor.isNativePlatform() &&
    Capacitor.getPlatform() === "ios" &&
    Capacitor.isPluginAvailable(PLUGIN_NAME)
  );
}

function stringField(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function normalizeResult(value: unknown): NotificationDeliveryResult {
  if (typeof value !== "object" || value === null) {
    return {
      status: "unknown",
      errorMessage: "invalid_sender_notification_result",
    };
  }
  const result = value as Record<string, unknown>;
  switch (result.status) {
    case "posted":
      return { status: "posted" };
    case "duplicate":
      return { status: "duplicate" };
    case "blocked":
      return {
        status: "blocked",
        ...(typeof result.reason === "string" ? { reason: result.reason } : {}),
      };
    case "failed":
      if (typeof result.postingMayHaveBegun !== "boolean") {
        break;
      }
      return {
        status: "failed",
        postingMayHaveBegun: result.postingMayHaveBegun,
        ...(typeof result.errorMessage === "string"
          ? { errorMessage: result.errorMessage }
          : {}),
      };
    case "unknown":
      return {
        status: "unknown",
        ...(typeof result.errorMessage === "string"
          ? { errorMessage: result.errorMessage }
          : {}),
      };
    case "unavailable":
      return {
        status: "unavailable",
        ...(typeof result.reason === "string" ? { reason: result.reason } : {}),
      };
  }
  return {
    status: "unknown",
    errorMessage: "invalid_sender_notification_result",
  };
}

function normalizePostResult(value: unknown): NotificationDeliveryResult {
  const result = normalizeResult(value);
  if (result.status === "unavailable") {
    return {
      status: "unknown",
      errorMessage: result.reason ?? "sender_notification_post_unavailable",
    };
  }
  return result;
}

async function beforeOwnershipCapabilities(): Promise<
  ReadonlySet<string> | null
> {
  if (!isBridgeRegistered()) {
    return null;
  }
  capabilityRequest ??= Promise.resolve()
    .then(() => SenderNotification.getCapabilities())
    .then((result) => {
      if (
        result.version !== CONTRACT_VERSION ||
        !Array.isArray(result.capabilities) ||
        !result.capabilities.every(
          (capability): capability is string => typeof capability === "string",
        )
      ) {
        return null;
      }
      return new Set(result.capabilities);
    })
    .catch(() => null);

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      capabilityRequest,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), watchdogMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function callPreparedIdentityMethod(
  call: () => Promise<unknown>,
): Promise<void> {
  const capabilities = await beforeOwnershipCapabilities();
  if (!capabilities?.has(PREPARED_IDENTITY_CAPABILITY)) {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(call).catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, watchdogMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export async function prepareSenderNotificationIdentity(
  payload: PrepareNotificationIdentityPayload,
): Promise<void> {
  await callPreparedIdentityMethod(() => SenderNotification.prepare(payload));
}

export async function resetSenderNotificationIdentities(
  payload: ResetNotificationIdentitiesPayload,
): Promise<void> {
  await callPreparedIdentityMethod(() => SenderNotification.reset(payload));
}

const identityAdapter = {
  prepareIdentity: prepareSenderNotificationIdentity,
  resetIdentities: resetSenderNotificationIdentities,
};

/** Connect scoped preparation only on an iOS shell that registers the plugin. */
export function installSenderNotificationIdentityAdapter(): void {
  if (isBridgeRegistered()) {
    setNotificationIdentityNativeAdapter(identityAdapter);
  }
}

/**
 * Hand one delivery to the native owner. An unavailable result is emitted only
 * before ownership. Every ambiguous post response remains owned by native and
 * normalizes to `unknown`.
 */
export async function postSenderNotification(
  payload: SenderNotificationPostRequest,
): Promise<NotificationDeliveryResult> {
  const capabilities = await beforeOwnershipCapabilities();
  if (
    !capabilities?.has(SINGLE_POST_OWNER_CAPABILITY) ||
    !capabilities.has(DELIVERY_STATUS_CAPABILITY)
  ) {
    return {
      status: "unavailable",
      reason: "sender_notification_unavailable",
    };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => SenderNotification.post(payload))
        .then(normalizePostResult)
        .catch((error: unknown) => ({
          status: "unknown" as const,
          errorMessage: stringField(error, "sender_notification_bridge_error"),
        })),
      new Promise<NotificationDeliveryResult>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              status: "unknown",
              errorMessage: "sender_notification_watchdog_expired",
            }),
          watchdogMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** Whether native explicitly confirmed that legacy scheduling is still safe. */
export function allowsLegacyNotificationFallback(
  result: NotificationDeliveryResult,
): boolean {
  return (
    result.status === "unavailable" ||
    (result.status === "failed" && !result.postingMayHaveBegun)
  );
}

export function __resetSenderNotificationForTests(): void {
  watchdogMs = DEFAULT_WATCHDOG_MS;
  capabilityRequest = null;
}

export function __setSenderNotificationWatchdogForTests(ms: number): void {
  watchdogMs = ms;
}
