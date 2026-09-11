/**
 * Bus consumer for `notification_intent` SSE events.
 *
 * Turns daemon-pushed notification intents into local browser or
 * Capacitor notifications. Skips guardian-scoped notifications
 * (the web client does not participate in guardian binding) and
 * notifications for the conversation the user is watching right now,
 * which takes three facts: the store's active conversation, a route
 * that mounts the chat surface, and a client that is on screen.
 * `isVisibleToUser()` answers the last one on every platform: the main
 * process's window report in the Electron renderer, `document.visibilityState`
 * in a browser tab and in the Capacitor shell. A hidden tab that reads
 * itself visible acks a notification nobody saw, and no web surface has a
 * push fallback to deliver it again.
 *
 * Acks every notification back to the daemon so delivery audit
 * trails stay consistent with the macOS client.
 *
 * References:
 * - EVENT_BUS.md — bus subscription contract
 * - runtime/notifications.ts — notification scheduling and ack API
 */

import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "react-router";

import { identityGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { resolveAssistantAvatarOwnerScopeId } from "@/hooks/use-assistant-avatar";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { getSoundManager } from "@/lib/sounds/sound-manager";
import { getSelfHostedIngressUrl } from "@/lib/self-hosted/connection";
import { createNotificationIdentity } from "@/runtime/notification-avatar";
import {
  extractConversationId,
  postLocalNotification,
  sendNotificationIntentAck,
} from "@/runtime/notifications";
import { isVisibleToUser } from "@/runtime/window-attention";
import { useAuthStore } from "@/stores/auth-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useRequestOrganizationId } from "@/stores/organization-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import type { IdentityGetResponse } from "@/generated/daemon/types.gen";
import { isConversationChatPath } from "@/utils/routes";
import { isUuid } from "@/utils/uuid";

/**
 * Subscribes to `notification_intent` SSE events via the event bus
 * and schedules local notifications.
 *
 * @param assistantId — current assistant; `null` disables the subscription
 */
export function useNotificationIntentSync(assistantId: string | null): void {
  // Basename-relative, unlike `window.location.pathname`, which carries the
  // public ingress prefix in remote-gateway mode.
  const { pathname } = useLocation();
  const queryClient = useQueryClient();
  const sessionStatus = useAuthStore.use.sessionStatus();
  const authUser = useAuthStore.use.user();
  const requestOrganizationId = useRequestOrganizationId();
  const assistants = useResolvedAssistantsStore.use.assistants();
  const assistant = assistants.find((candidate) => candidate.id === assistantId);
  const platformAccountId =
    authUser?.kind === "platform" ? authUser.id : null;
  const connectionFallback =
    getSelfHostedIngressUrl() ??
    (typeof globalThis.location === "undefined"
      ? null
      : globalThis.location.href);
  const scopeId =
    sessionStatus === "authenticated"
      ? resolveAssistantAvatarOwnerScopeId(
          assistant,
          platformAccountId,
          requestOrganizationId,
          connectionFallback,
        )
      : null;
  const platformAssistantId =
    assistant?.platformAssistantId && isUuid(assistant.platformAssistantId)
      ? assistant.platformAssistantId
      : assistant?.isPlatformHosted && isUuid(assistant.id)
        ? assistant.id
        : null;
  const notificationIdentity = useMemo(
    () =>
      assistantId && scopeId
        ? createNotificationIdentity(
            scopeId,
            assistantId,
            platformAssistantId,
          )
        : null,
    [assistantId, platformAssistantId, scopeId],
  );

  useBusSubscription("sse.event", (envelope) => {
    const event = envelope.message;
    if (event.type !== "notification_intent") {
      return;
    }

    const originatingAssistantId = assistantId;
    const originatingIdentity = notificationIdentity;
    const scopedIdentityData = originatingIdentity
      ? queryClient.getQueryData<IdentityGetResponse | null>([
          ...identityGetQueryKey({
            path: { assistant_id: originatingAssistantId ?? "" },
          }),
          { notificationOwnerScopeId: originatingIdentity.scopeId },
        ])
      : null;
    const identityStoreName =
      originatingIdentity && scopedIdentityData?.name?.trim()
        ? {
            identity: originatingIdentity,
            name: scopedIdentityData.name,
          }
        : null;

    // Guardian-scoped notifications are for devices bound to that
    // guardian identity. The web/Capacitor client does not participate
    // in guardian binding — skip to avoid leaking to unintended devices.
    if (event.targetGuardianPrincipalId) {
      if (originatingAssistantId && event.deliveryId) {
        void sendNotificationIntentAck(
          originatingAssistantId,
          event.deliveryId,
          true,
        );
      }
      return;
    }

    // Suppress only when the message is already in front of the user.
    // `activeConversationId` survives navigation, so the route has to agree;
    // a minimized window or a backgrounded tab on that conversation shows
    // nothing, and a skip there would ack a delivery nobody saw.
    const metadataConversationId = extractConversationId(
      event.deepLinkMetadata,
    );
    if (
      metadataConversationId &&
      metadataConversationId ===
        useConversationStore.getState().activeConversationId &&
      isConversationChatPath(pathname) &&
      isVisibleToUser()
    ) {
      if (originatingAssistantId && event.deliveryId) {
        void sendNotificationIntentAck(
          originatingAssistantId,
          event.deliveryId,
          true,
        );
      }
      return;
    }

    void getSoundManager().play("notification");
    void postLocalNotification({
      title: event.title,
      body: event.body,
      sourceEventName: event.sourceEventName,
      assistantName: event.assistantName,
      deliveryId: event.deliveryId,
      correlationId: event.correlationId,
      deepLinkMetadata: event.deepLinkMetadata,
      assistantId: originatingAssistantId ?? undefined,
      identity: originatingIdentity ?? undefined,
      identityStoreName,
      remotePushDispatched: event.remotePushDispatched,
      remotePushPlatforms: event.remotePushPlatforms,
    });
  });
}
