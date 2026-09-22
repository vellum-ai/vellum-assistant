/**
 * Bus consumer for `notification_intent` SSE events.
 *
 * Turns daemon-pushed notification intents into local browser or
 * Capacitor notifications. Skips intents the daemon marks `silent`, which
 * resolves independently of urgency: silent signals reach their
 * conversation (and the home feed, for background work) without a banner.
 * Skips guardian-scoped notifications from an assistant that broadcasts
 * them to every connection (see
 * `lib/backwards-compat/guardian-notification-targeting.ts`), and
 * notifications for the conversation the user is watching right now,
 * which takes three facts: the store's active conversation, a route
 * that mounts the chat surface, and a client that is on screen.
 * `isClientAttended()` answers the last one: Electron host attention,
 * browser visibility plus focus, and native mobile foreground visibility. A hidden tab that reads
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

import { useEffect, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "react-router";

import { identityGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import {
  resolveAssistantAvatarOwnerScopeId,
  resolveAssistantNotificationPlatformId,
} from "@/hooks/use-assistant-avatar";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { supportsGuardianNotificationTargeting } from "@/lib/backwards-compat/guardian-notification-targeting";
import { getSoundManager } from "@/lib/sounds/sound-manager";
import { getSelfHostedIngressUrl } from "@/lib/self-hosted/connection";
import { createNotificationIdentity } from "@/runtime/notification-avatar";
import {
  browserNotificationConversationKey,
  browserNotificationDelivery,
} from "@/runtime/browser-notification-delivery";
import {
  extractConversationId,
  isFocusedNotificationConversation,
  isBrowserNotificationHost,
  postLocalNotification,
  sendNotificationIntentAck,
  shouldSuppressFocusedNotificationDelivery,
} from "@/runtime/notifications";
import { useAuthStore } from "@/stores/auth-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useRequestOrganizationId } from "@/stores/organization-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import type { IdentityGetResponse } from "@/generated/daemon/types.gen";

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
  const activeConversationId = useConversationStore.use.activeConversationId();
  const queryClient = useQueryClient();
  const sessionStatus = useAuthStore.use.sessionStatus();
  const authUser = useAuthStore.use.user();
  const requestOrganizationId = useRequestOrganizationId();
  const assistants = useResolvedAssistantsStore.use.assistants();
  const assistant = assistants.find(
    (candidate) => candidate.id === assistantId,
  );
  const platformAccountId = authUser?.kind === "platform" ? authUser.id : null;
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
  const platformAssistantId = resolveAssistantNotificationPlatformId(assistant);
  const notificationIdentity = useMemo(
    () =>
      assistantId && scopeId
        ? createNotificationIdentity(scopeId, assistantId, platformAssistantId)
        : null,
    [assistantId, platformAssistantId, scopeId],
  );

  const deliveryOwner = useRef(notificationIdentity);
  useEffect(() => {
    deliveryOwner.current = notificationIdentity;
    return () => {
      deliveryOwner.current = null;
    };
  }, [notificationIdentity]);

  useEffect(() => {
    if (!notificationIdentity || !isBrowserNotificationHost()) {
      return;
    }
    return browserNotificationDelivery.trackAttention(() =>
      activeConversationId &&
      deliveryOwner.current === notificationIdentity &&
      isFocusedNotificationConversation(activeConversationId, pathname)
        ? browserNotificationConversationKey(
            notificationIdentity,
            activeConversationId,
          )
        : null,
    );
  }, [activeConversationId, notificationIdentity, pathname]);

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

    // An assistant that predates guardian targeting broadcasts the guardian's
    // approval text to every connection, and this one may not be the
    // guardian's.
    if (
      event.targetGuardianPrincipalId &&
      !supportsGuardianNotificationTargeting(originatingAssistantId)
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

    // Non-urgent intents never reach the OS notification surface. Nothing is
    // posted and no chime plays, so the ack records a handled intent rather
    // than a failure.
    if (event.silent === true) {
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
    const focused =
      metadataConversationId !== undefined &&
      isFocusedNotificationConversation(metadataConversationId, pathname);
    if (
      shouldSuppressFocusedNotificationDelivery(
        event.correlationId,
        event.deliveryId,
        focused,
      )
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

    void (async () => {
      const soundDisposition = await postLocalNotification({
        canDeliver: () =>
          originatingIdentity !== null && deliveryOwner.current === originatingIdentity,
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
      if (soundDisposition === "web-sound") {
        await getSoundManager().play("notification");
      }
    })();
  });
}
