import type { NotificationIdentity } from "@vellumai/ipc-contract";

import { subscribe } from "@/lib/event-bus";
import { captureError } from "@/lib/sentry/capture-error";
import { mintRandomId } from "@/lib/telemetry/random-id";

const STORAGE_KEY = "vellum:browser-notification-deliveries:v1";
const MAX_DELIVERIES = 128;
const RETENTION_MS = 10 * 60_000;
const ATTENTION_PREFIX = "vellum:browser-notification-attention:v1:";
const ATTENTION_TTL_MS = 15_000;
const ATTENTION_REFRESH_MS = 5_000;

type DeliveryResult = "posted" | "duplicate" | "cancelled" | "suppressed";
type Receipt = [key: string, expiresAt: number];

export function browserNotificationConversationKey(
  identity: NotificationIdentity | null | undefined,
  conversationId: string | null | undefined,
): string | null {
  return identity && conversationId
    ? JSON.stringify([identity.scopeId, identity.assistantId, conversationId])
    : null;
}

/** One instance per page; Web Locks serialize the same-origin receipt ledger. */
export class BrowserNotificationDelivery {
  private recent = new Map<string, number>();
  private attentionReaders = new Set<() => string | null>();

  /** Publish attention before an intent arrives, including in other tabs. */
  trackAttention(readConversationKey: () => string | null): () => void {
    const storageKey = `${ATTENTION_PREFIX}${mintRandomId()}`;
    this.attentionReaders.add(readConversationKey);
    let published = false;
    const update = () => {
      try {
        const conversationKey = readConversationKey();
        if (conversationKey) {
          localStorage.setItem(
            storageKey,
            JSON.stringify([conversationKey, Date.now() + ATTENTION_TTL_MS]),
          );
          published = true;
        } else if (published) {
          localStorage.removeItem(storageKey);
          published = false;
        }
      } catch (error) {
        captureError(error, { context: "browser_notification.write_attention" });
      }
    };
    const subscriptions = [
      subscribe("app.attention", update),
      subscribe("app.resume", update),
      subscribe("app.hidden", update),
    ];
    // An abandoned page must not suppress future notifications indefinitely.
    const interval = setInterval(update, ATTENTION_REFRESH_MS);
    update();
    return () => {
      this.attentionReaders.delete(readConversationKey);
      clearInterval(interval);
      subscriptions.forEach((unsubscribe) => unsubscribe());
      try {
        localStorage.removeItem(storageKey);
      } catch (error) {
        captureError(error, { context: "browser_notification.clear_attention" });
      }
    };
  }

  isConversationAttended(conversationKey: string | null): boolean {
    if (!conversationKey) {
      return false;
    }
    let attended = [...this.attentionReaders].some(
      (read) => read() === conversationKey,
    );
    const now = Date.now();
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const storageKey = localStorage.key(i);
        if (!storageKey?.startsWith(ATTENTION_PREFIX)) {
          continue;
        }
        let entry: unknown;
        try {
          entry = JSON.parse(localStorage.getItem(storageKey) ?? "null");
        } catch (error) {
          captureError(error, { context: "browser_notification.parse_attention" });
          localStorage.removeItem(storageKey);
          continue;
        }
        if (
          !Array.isArray(entry) ||
          entry.length !== 2 ||
          typeof entry[0] !== "string" ||
          typeof entry[1] !== "number" ||
          entry[1] <= now ||
          entry[1] > now + ATTENTION_TTL_MS
        ) {
          localStorage.removeItem(storageKey);
          continue;
        }
        if (entry[0] === conversationKey) {
          attended = true;
        }
      }
    } catch (error) {
      captureError(error, { context: "browser_notification.read_attention" });
    }
    return attended;
  }

  resetForTests(): void {
    this.recent.clear();
    localStorage.removeItem(STORAGE_KEY);
  }

  async post(
    key: string | null,
    deliver: () => void,
    canDeliver: () => boolean = () => true,
    conversationKey: string | null = null,
  ): Promise<DeliveryResult> {
    const claim = (): DeliveryResult => {
      if (!canDeliver()) {
        return "cancelled";
      }
      if (this.isConversationAttended(conversationKey)) {
        return "suppressed";
      }
      if (!key) {
        deliver();
        return "posted";
      }
      const now = Date.now();
      let receipts: Receipt[] = [];
      try {
        const value: unknown = JSON.parse(
          localStorage.getItem(STORAGE_KEY) ?? "[]",
        );
        if (Array.isArray(value)) {
          receipts = value
            .filter((entry): entry is Receipt =>
              Array.isArray(entry) &&
              entry.length === 2 &&
              typeof entry[0] === "string" &&
              typeof entry[1] === "number" &&
              entry[1] > now,
            )
            .slice(-MAX_DELIVERIES);
        }
      } catch (error) {
        captureError(error, { context: "browser_notification.read_receipts" });
      }
      this.recent = new Map(
        [...this.recent, ...receipts]
          .filter(([, expiresAt]) => expiresAt > now)
          .slice(-MAX_DELIVERIES),
      );
      if (this.recent.has(key)) {
        return "duplicate";
      }
      // Posting is synchronous inside the lock. A failed post retains no
      // claim, so another tab can attempt the same delivery.
      deliver();
      this.recent.set(key, now + RETENTION_MS);
      this.recent = new Map([...this.recent].slice(-MAX_DELIVERIES));
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([...this.recent]));
      } catch (error) {
        captureError(error, { context: "browser_notification.write_receipts" });
      }
      return "posted";
    };

    if (key && typeof navigator !== "undefined" && navigator.locks?.request) {
      let enteredClaim = false;
      try {
        return await navigator.locks.request(STORAGE_KEY, () => {
          enteredClaim = true;
          return claim();
        });
      } catch (error) {
        if (enteredClaim) {
          throw error;
        }
        captureError(error, { context: "browser_notification.acquire_lock" });
      }
    }
    // Older browsers retain page-local deduplication and a shared OS tag.
    // Without Web Locks the same-origin read/write is not atomic.
    return claim();
  }
}

export const browserNotificationDelivery = new BrowserNotificationDelivery();
