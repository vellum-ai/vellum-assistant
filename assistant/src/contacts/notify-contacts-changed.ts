import { invalidateAllContactThresholdCaches } from "../permissions/gateway-threshold-reader.js";
import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import { invalidateGuardianContactCache } from "./guardian-contact-reader.js";
import { invalidateGuardianDeliveryCache } from "./guardian-delivery-reader.js";

/**
 * Notify everything that cares about a contact mutation. Called directly after
 * a successful contact write:
 *
 * - broadcasts `contacts_changed` so connected clients refresh their view,
 * - drops the guardian-contact, guardian-delivery, and contact-threshold
 *   caches so the next read refetches from the gateway instead of serving
 *   a stale set, and
 * - asks the mirror reconciler for a debounced convergence pass, so identity
 *   drift the per-write mirror ops missed heals on the next contact activity.
 *
 * The reconciler is reached via dynamic import: it applies its heals through
 * the contact-store primitives, whose writes land back here, and a static
 * import would close that cycle at module-load time.
 */
export function notifyContactsChanged(): void {
  broadcastMessage({ type: "contacts_changed" });
  invalidateGuardianContactCache();
  invalidateGuardianDeliveryCache();
  invalidateAllContactThresholdCaches();
  void import("./mirror-reconciler.js")
    .then((m) => m.scheduleMirrorReconcile())
    .catch(() => {});
}
