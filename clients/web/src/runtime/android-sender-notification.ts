/** Version-skew-safe bridge to Android's process-local notification owner. */

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

const SENDER_PLUGIN_NAME = "AndroidSenderNotification";
const CONTRACT_VERSION = 1;
const PREPARED_IDENTITY_CAPABILITY = "preparedIdentity";
const IDENTITY_PUBLISHER_SESSIONS_CAPABILITY = "identityPublisherSessions";
const SINGLE_POST_OWNER_CAPABILITY = "singlePostOwner";
const DELIVERY_STATUS_CAPABILITY = "deliveryStatus";
const DEFAULT_WATCHDOG_MS = 2_000;

interface AndroidSenderNotificationCapabilities {
  version?: unknown;
  capabilities?: unknown;
}

export interface AndroidSenderNotificationPostRequest
  extends NotificationDeliveryIdentifiers {
  id: number;
  title: string;
  body: string;
  extra: object;
  actionTypeId?: string;
  channelId?: string;
  category?: string;
  conversationId?: string;
  deepLinkMetadata?: Record<string, unknown>;
  presentation: NotificationPresentation;
  identity?: NotificationIdentity;
  name?: string;
  nameProvenance?: NotificationNameProvenance;
  suppressGroupTitle?: boolean;
  sender?: NotificationSender;
}

interface AndroidSenderNotificationPlugin {
  getCapabilities(payload?: {
    publisherSessionId: string;
  }): Promise<AndroidSenderNotificationCapabilities>;
  prepare(
    payload: PrepareNotificationIdentityPayload,
  ): Promise<{ ok?: boolean }>;
  reset(
    payload: ResetNotificationIdentitiesPayload,
  ): Promise<{ ok?: boolean }>;
  post(
    payload: AndroidSenderNotificationPostRequest,
  ): Promise<NotificationDeliveryResult>;
  status(
    payload: NotificationDeliveryIdentifiers,
  ): Promise<NotificationDeliveryResult>;
}

export interface AndroidNotificationOwnershipOptions {
  version: number;
  generation: number;
  active: boolean;
}

export interface AndroidNotificationOwnershipBridge {
  getNotificationOwnershipGeneration(): Promise<unknown>;
  setNotificationOwnership(
    options: AndroidNotificationOwnershipOptions,
  ): Promise<unknown>;
}

const AndroidSenderNotification =
  registerPlugin<AndroidSenderNotificationPlugin>(SENDER_PLUGIN_NAME);

let watchdogMs = DEFAULT_WATCHDOG_MS;
let capabilityRequest: Promise<ReadonlySet<string> | null> | null = null;
let ownershipEnabled = false;
let ownershipGeneration: number | null = null;
let ownershipTransition:
  | { promise: Promise<void>; resolve: () => void }
  | null = null;

function isAndroidBridgeRegistered(): boolean {
  return (
    Capacitor.isNativePlatform() &&
    Capacitor.getPlatform() === "android" &&
    Capacitor.isPluginAvailable(SENDER_PLUGIN_NAME)
  );
}

function stringField(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function normalizeResult(value: unknown): NotificationDeliveryResult {
  if (typeof value !== "object" || value === null) {
    return {
      status: "unknown",
      errorMessage: "invalid_android_sender_notification_result",
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
      if (typeof result.postingMayHaveBegun === "boolean") {
        return {
          status: "failed",
          postingMayHaveBegun: result.postingMayHaveBegun,
          ...(typeof result.errorMessage === "string"
            ? { errorMessage: result.errorMessage }
            : {}),
        };
      }
      break;
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
    errorMessage: "invalid_android_sender_notification_result",
  };
}

function normalizePostResult(value: unknown): NotificationDeliveryResult {
  const result = normalizeResult(value);
  if (result.status === "unavailable") {
    return {
      status: "unknown",
      errorMessage:
        result.reason ?? "android_sender_notification_post_unavailable",
    };
  }
  return result;
}

function normalizeCapabilities(
  result: AndroidSenderNotificationCapabilities,
): ReadonlySet<string> | null {
  if (
    typeof result !== "object" ||
    result === null ||
    result.version !== CONTRACT_VERSION ||
    !Array.isArray(result.capabilities) ||
    !result.capabilities.every(
      (capability): capability is string => typeof capability === "string",
    )
  ) {
    return null;
  }
  return new Set(result.capabilities);
}

async function capabilities(): Promise<ReadonlySet<string> | null> {
  if (!isAndroidBridgeRegistered()) {
    return null;
  }
  capabilityRequest ??= Promise.resolve()
    .then(() => AndroidSenderNotification.getCapabilities())
    .then(normalizeCapabilities)
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
  const supported = await capabilities();
  if (!supported?.has(PREPARED_IDENTITY_CAPABILITY)) {
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

export async function prepareAndroidSenderNotificationIdentity(
  payload: PrepareNotificationIdentityPayload,
): Promise<void> {
  await callPreparedIdentityMethod(() => AndroidSenderNotification.prepare(payload));
}

export async function resetAndroidSenderNotificationIdentities(
  payload: ResetNotificationIdentitiesPayload,
): Promise<void> {
  await callPreparedIdentityMethod(() => AndroidSenderNotification.reset(payload));
}

async function registerAndroidSenderNotificationIdentityPublisher(
  publisherSessionId: string,
): Promise<boolean> {
  if (!isAndroidBridgeRegistered()) {
    return false;
  }
  capabilityRequest = Promise.resolve()
    .then(() =>
      AndroidSenderNotification.getCapabilities({ publisherSessionId }),
    )
    .then(normalizeCapabilities)
    .catch(() => null);
  const supported = await capabilities();
  return supported?.has(IDENTITY_PUBLISHER_SESSIONS_CAPABILITY) === true;
}

const identityAdapter = {
  registerIdentityPublisher:
    registerAndroidSenderNotificationIdentityPublisher,
  prepareIdentity: prepareAndroidSenderNotificationIdentity,
  resetIdentities: resetAndroidSenderNotificationIdentities,
};

export function installAndroidSenderNotificationIdentityAdapter(): void {
  if (isAndroidBridgeRegistered()) {
    setNotificationIdentityNativeAdapter(identityAdapter);
  }
}

function supportsOwnership(supported: ReadonlySet<string> | null): boolean {
  return (
    supported?.has(PREPARED_IDENTITY_CAPABILITY) === true &&
    supported.has(SINGLE_POST_OWNER_CAPABILITY) &&
    supported.has(DELIVERY_STATUS_CAPABILITY)
  );
}

function settleOwnershipTransition(): void {
  ownershipTransition?.resolve();
  ownershipTransition = null;
}

/** Block local posts synchronously while foreground ownership is negotiated. */
export function beginAndroidNotificationOwnershipEnable(): void {
  if (
    ownershipEnabled ||
    ownershipTransition !== null ||
    !isAndroidBridgeRegistered()
  ) {
    return;
  }
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  ownershipTransition = { promise, resolve };
}

async function generationRequest(
  bridge: AndroidNotificationOwnershipBridge,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => bridge.getNotificationOwnershipGeneration())
        .catch(() => null),
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

async function ownershipRequest(
  active: boolean,
  generation: number,
  bridge: AndroidNotificationOwnershipBridge,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() =>
          bridge.setNotificationOwnership({
            version: CONTRACT_VERSION,
            generation,
            active,
          }),
        )
        .catch(() => null),
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

function ownershipRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function ownershipGenerationFrom(value: unknown): number | null {
  const record = ownershipRecord(value);
  return record?.version === CONTRACT_VERSION &&
    typeof record.generation === "number" &&
    Number.isSafeInteger(record.generation) &&
    record.generation >= 0
    ? record.generation
    : null;
}

/** Enable the local coordinator before asking native to transfer FCM ownership. */
export async function enableAndroidNotificationOwnership(
  bridge: AndroidNotificationOwnershipBridge,
): Promise<boolean> {
  beginAndroidNotificationOwnershipEnable();
  try {
    const supported = await capabilities();
    if (!supportsOwnership(supported)) {
      ownershipEnabled = false;
      ownershipGeneration = null;
      return false;
    }

    const generation = ownershipGenerationFrom(
      await generationRequest(bridge),
    );
    if (generation === null) {
      ownershipEnabled = false;
      ownershipGeneration = null;
      return false;
    }

    ownershipEnabled = true;
    ownershipGeneration = generation;
    const result = ownershipRecord(
      await ownershipRequest(true, generation, bridge),
    );
    return (
      result?.version === CONTRACT_VERSION &&
      result.generation === generation &&
      result.active === true &&
      result.accepted === true
    );
  } finally {
    settleOwnershipTransition();
  }
}

/** Clear native first so the local poster cannot leave the coordinator early. */
export async function disableAndroidNotificationOwnership(
  bridge: AndroidNotificationOwnershipBridge,
): Promise<boolean> {
  if (!ownershipEnabled) {
    return true;
  }
  const generation = ownershipGeneration;
  if (generation === null) {
    return false;
  }
  const result = ownershipRecord(
    await ownershipRequest(false, generation, bridge),
  );
  const disabled =
    result?.version === CONTRACT_VERSION &&
    result.generation === generation &&
    result.active === false &&
    result.accepted === true;
  if (disabled) {
    ownershipEnabled = false;
    ownershipGeneration = null;
  }
  return disabled;
}

export async function postAndroidSenderNotification(
  payload: AndroidSenderNotificationPostRequest,
): Promise<NotificationDeliveryResult> {
  await ownershipTransition?.promise;
  if (!ownershipEnabled) {
    return {
      status: "unavailable",
      reason: "android_notification_ownership_inactive",
    };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => AndroidSenderNotification.post(payload))
        .then(normalizePostResult)
        .catch((error: unknown) => ({
          status: "unknown" as const,
          errorMessage: stringField(
            error,
            "android_sender_notification_bridge_error",
          ),
        })),
      new Promise<NotificationDeliveryResult>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              status: "unknown",
              errorMessage: "android_sender_notification_watchdog_expired",
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

export function allowsLegacyAndroidNotificationFallback(
  result: NotificationDeliveryResult,
): boolean {
  return (
    result.status === "unavailable" ||
    (result.status === "failed" && !result.postingMayHaveBegun)
  );
}

export function __resetAndroidSenderNotificationForTests(): void {
  watchdogMs = DEFAULT_WATCHDOG_MS;
  capabilityRequest = null;
  ownershipEnabled = false;
  ownershipGeneration = null;
  settleOwnershipTransition();
}

export function __setAndroidSenderNotificationWatchdogForTests(ms: number): void {
  watchdogMs = ms;
}
