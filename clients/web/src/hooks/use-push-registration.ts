/**
 * Lifecycle hook that registers the Capacitor iOS app for APNs remote push.
 *
 * When an assistant becomes active, this acquires an APNs device token and
 * upserts it to the platform so the daemon's `platform` notification channel
 * can deliver background notifications (reminders fire while the app is
 * suspended, where the local-notification path cannot reach the device).
 *
 * No-ops off native iOS. Token deletion on logout is handled in
 * `stores/auth-store.ts` (before the session cookie is cleared), not here —
 * the assistant-id change on logout races session teardown, so the platform
 * delete must run while the session is still valid.
 *
 * References:
 * - runtime/push-registration.ts — registration + token upsert
 * - hooks/use-notification-intent-sync.ts — sibling local-notification path
 */

import { useEffect } from "react";

import { registerForRemotePush } from "@/runtime/push-registration";

/**
 * Registers for APNs remote push whenever an assistant is active.
 *
 * @param assistantId — current assistant; `null` disables registration
 */
export function usePushRegistration(assistantId: string | null): void {
  useEffect(() => {
    if (!assistantId) return;
    void registerForRemotePush(assistantId);
  }, [assistantId]);
}
