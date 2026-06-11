import {
  assistantsOauthConnectionsList,
  assistantsOauthStartCreate,
} from "@/generated/api/sdk.gen";
import type { OAuthConnection } from "@/generated/api/types.gen";
import { oauthProvidersGet } from "@/generated/daemon/sdk.gen";
import type { OauthProvidersGetResponses } from "@/generated/daemon/types.gen";
import {
  getOAuthCompleteMessagePayload,
  getOAuthCompleteStoragePayload,
  isOAuthCompletePayloadForRequest,
  oauthCompletionStorageKey,
  type OAuthCompletePayload,
} from "@/lib/auth/oauth-popup";
import { openUrl, openUrlFinishedListener } from "@/runtime/browser";
import { isNativePlatform } from "@/runtime/native-auth";
import {
  OAUTH_COMPLETE_DEEP_LINK_EVENT,
  type OAuthCompleteDeepLinkPayload,
} from "@/runtime/native-deep-link";
import { extractErrorMessage } from "@/utils/api-errors";
import {
  findNewOrChangedProviderConnection,
  getProviderConnectionSignatures,
  wait,
} from "@/utils/oauth-connection-utils";
import { routes } from "@/utils/routes";

export type ManagedOAuthProviderSummary =
  OauthProvidersGetResponses[200]["providers"][number];

export interface ManagedOAuthConnectOptions {
  assistantId: string;
  providerKey: string;
  providerLabel: string;
}

export type ManagedOAuthConnectResult =
  | { status: "connected"; connection: OAuthConnection | null }
  | { status: "cancelled"; message?: string }
  | { status: "error"; message: string };

export interface ManagedOAuthConnectClient {
  fetchProvider: (
    assistantId: string,
    providerKey: string,
  ) => Promise<ManagedOAuthProviderSummary | null>;
  connect: (
    options: ManagedOAuthConnectOptions,
  ) => Promise<ManagedOAuthConnectResult>;
}

const POPUP_CLOSE_GRACE_MS = 1000;
const POPUP_CHECK_INTERVAL_MS = 100;
const CONNECTION_POLL_ATTEMPTS = 8;
const CONNECTION_POLL_DELAY_MS = 750;

async function listOAuthConnections(
  assistantId: string,
): Promise<OAuthConnection[]> {
  const { data, error, response } = await assistantsOauthConnectionsList({
    path: { assistant_id: assistantId },
    throwOnError: false,
  });
  if (error || !data) {
    throw new Error(
      extractErrorMessage(
        error,
        response,
        "Failed to load OAuth connections.",
      ),
    );
  }
  return data;
}

async function waitForProviderConnection(
  assistantId: string,
  providerKey: string,
  baselineSignatures: ReadonlyMap<string, string>,
): Promise<OAuthConnection | null> {
  for (let attempt = 0; attempt < CONNECTION_POLL_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await wait(CONNECTION_POLL_DELAY_MS);
    }

    try {
      const connections = await listOAuthConnections(assistantId);
      const connected = findNewOrChangedProviderConnection(
        connections,
        providerKey,
        baselineSignatures,
      );
      if (connected) {
        return connected;
      }
    } catch {
      // Auth callbacks can race session refreshes; keep polling briefly.
    }
  }

  return null;
}

export async function fetchManagedOAuthProvider(
  assistantId: string,
  providerKey: string,
): Promise<ManagedOAuthProviderSummary | null> {
  const { data, error } = await oauthProvidersGet({
    path: { assistant_id: assistantId },
    query: { supports_managed_mode: "true" },
    throwOnError: false,
  });
  if (error || !data) {
    return null;
  }
  return (
    data.providers.find(
      (provider) =>
        provider.provider_key === providerKey &&
        provider.supports_managed_mode,
    ) ?? null
  );
}

async function startManagedOAuth(
  assistantId: string,
  providerKey: string,
  requestId: string,
  native: boolean,
): Promise<string> {
  const redirectAfterConnect = `${routes.account.oauth.popupComplete}?requestId=${requestId}${native ? "&native=1" : ""}`;
  const { data, error, response } = await assistantsOauthStartCreate({
    path: { assistant_id: assistantId, provider: providerKey },
    body: {
      requested_scopes: [],
      redirect_after_connect: redirectAfterConnect,
    },
    throwOnError: false,
  });

  if (error || !data?.connect_url) {
    throw new Error(
      extractErrorMessage(error, response, "Failed to start authorization."),
    );
  }

  return data.connect_url;
}

function readStoredCompletion(requestId: string): OAuthCompletePayload | null {
  const storedCompletion = window.localStorage.getItem(
    oauthCompletionStorageKey(requestId),
  );
  if (!storedCompletion) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(storedCompletion);
    return isOAuthCompletePayloadForRequest(parsed, requestId) ? parsed : null;
  } catch {
    return null;
  }
}

export async function connectManagedOAuthProvider({
  assistantId,
  providerKey,
  providerLabel,
}: ManagedOAuthConnectOptions): Promise<ManagedOAuthConnectResult> {
  const requestId = crypto.randomUUID();
  const native = isNativePlatform();
  const baselineSignatures = getProviderConnectionSignatures(
    await listOAuthConnections(assistantId).catch(() => []),
    providerKey,
  );

  return new Promise((resolve) => {
    let popup: Window | null = null;
    let settled = false;
    let popupCheckInterval: ReturnType<typeof setInterval> | null = null;
    let popupClosedGraceTimeout: ReturnType<typeof setTimeout> | null = null;
    let nativeFinishUnsub: (() => void) | null = null;

    const cleanup = () => {
      window.removeEventListener("message", handleOAuthMessage);
      window.removeEventListener("storage", handleOAuthStorage);
      window.removeEventListener(
        OAUTH_COMPLETE_DEEP_LINK_EVENT,
        handleOAuthDeepLink,
      );
      nativeFinishUnsub?.();
      nativeFinishUnsub = null;
      if (popupCheckInterval) {
        clearInterval(popupCheckInterval);
        popupCheckInterval = null;
      }
      if (popupClosedGraceTimeout) {
        clearTimeout(popupClosedGraceTimeout);
        popupClosedGraceTimeout = null;
      }
      if (popup && !popup.closed) {
        popup.close();
      }
      popup = null;
    };

    const finish = (result: ManagedOAuthConnectResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      window.localStorage.removeItem(oauthCompletionStorageKey(requestId));
      resolve(result);
    };

    const finishConnectedAfterPoll = async () => {
      const connection = await waitForProviderConnection(
        assistantId,
        providerKey,
        baselineSignatures,
      );
      if (connection) {
        finish({ status: "connected", connection });
      } else {
        finish({
          status: "error",
          message: `${providerLabel} connection finished, but no connected account was found.`,
        });
      }
    };

    const handleOAuthCompletePayload = (payload: OAuthCompletePayload) => {
      if (payload.oauthStatus === "connected") {
        void finishConnectedAfterPoll();
        return;
      }
      finish({
        status: "error",
        message: payload.oauthCode
          ? `${providerLabel} authorization failed: ${payload.oauthCode}`
          : `${providerLabel} authorization failed.`,
      });
    };

    function handleOAuthMessage(event: MessageEvent) {
      const payload = getOAuthCompleteMessagePayload(
        event,
        window.location.origin,
        requestId,
      );
      if (payload) {
        handleOAuthCompletePayload(payload);
      }
    }

    function handleOAuthStorage(event: StorageEvent) {
      const payload = getOAuthCompleteStoragePayload(event, requestId);
      if (payload) {
        handleOAuthCompletePayload(payload);
      }
    }

    function handleOAuthDeepLink(
      event: CustomEvent<OAuthCompleteDeepLinkPayload>,
    ) {
      const payload = event.detail;
      if (payload.requestId !== requestId) return;
      handleOAuthCompletePayload({
        type: "vellum:oauth-complete",
        requestId: payload.requestId,
        oauthStatus: payload.oauthStatus,
        oauthProvider: payload.oauthProvider,
        oauthCode: payload.oauthCode,
      });
    }

    const handlePopupClosed = async () => {
      const storedCompletion = readStoredCompletion(requestId);
      if (storedCompletion) {
        handleOAuthCompletePayload(storedCompletion);
        return;
      }

      const connection = await waitForProviderConnection(
        assistantId,
        providerKey,
        baselineSignatures,
      );
      if (connection) {
        finish({ status: "connected", connection });
        return;
      }

      finish({
        status: "cancelled",
        message: `${providerLabel} authorization popup closed.`,
      });
    };

    const start = async () => {
      window.addEventListener("message", handleOAuthMessage);
      window.addEventListener("storage", handleOAuthStorage);
      window.addEventListener(
        OAUTH_COMPLETE_DEEP_LINK_EVENT,
        handleOAuthDeepLink,
      );

      if (!native) {
        popup = window.open("", "_blank", "width=500,height=600");
        if (popup === null) {
          finish({
            status: "error",
            message: "Popup blocked. Please enable popups and try again.",
          });
          return;
        }
      } else {
        nativeFinishUnsub = openUrlFinishedListener(() => {
          void handlePopupClosed();
        });
      }

      try {
        const connectUrl = await startManagedOAuth(
          assistantId,
          providerKey,
          requestId,
          native,
        );

        if (native) {
          await openUrl(connectUrl);
          return;
        }

        if (popup && !popup.closed) {
          popup.location.href = connectUrl;
        } else {
          finish({
            status: "cancelled",
            message: `${providerLabel} authorization popup closed.`,
          });
          return;
        }

        popupCheckInterval = setInterval(() => {
          if (popup && popup.closed && !popupClosedGraceTimeout && !settled) {
            popupClosedGraceTimeout = setTimeout(() => {
              popupClosedGraceTimeout = null;
              void handlePopupClosed();
            }, POPUP_CLOSE_GRACE_MS);
          }
        }, POPUP_CHECK_INTERVAL_MS);
      } catch (error) {
        finish({
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : `Failed to start ${providerLabel} authorization.`,
        });
      }
    };

    void start();
  });
}

export const defaultManagedOAuthConnectClient: ManagedOAuthConnectClient = {
  fetchProvider: fetchManagedOAuthProvider,
  connect: connectManagedOAuthProvider,
};
