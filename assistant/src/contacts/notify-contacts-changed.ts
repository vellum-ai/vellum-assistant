import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import { invalidateGuardianContactCache } from "./guardian-contact-reader.js";
import { invalidateGuardianDeliveryCache } from "./guardian-delivery-reader.js";

/**
 * Notify everything that cares about a contact mutation. Called directly after
 * a successful contact write:
 *
 * - broadcasts `contacts_changed` so connected clients refresh their view, and
 * - drops the guardian-contact and guardian-delivery caches so the next read
 *   refetches from the gateway instead of serving a stale set.
 */
export function notifyContactsChanged(): void {
  broadcastMessage({ type: "contacts_changed" });
  invalidateGuardianContactCache();
  invalidateGuardianDeliveryCache();
}
