import type { NotificationIdentity } from "@vellumai/ipc-contract";

import { subscribe } from "@/lib/event-bus";
import { captureError } from "@/lib/sentry/capture-error";
import { mintRandomId } from "@/lib/telemetry/random-id";

const STORAGE_KEY = "vellum:browser-notification-deliveries:v1";
const SOUND_STORAGE_KEY = "vellum:browser-notification-sounds:v1";
const DATABASE_NAME = "vellum-browser-notifications";
const RECEIPTS_STORE = "receipts";
const MAX_DELIVERIES = 128;
const RETENTION_MS = 10 * 60_000;
const ATTENTION_PREFIX = "vellum:browser-notification-attention:v1:";
const ATTENTION_TTL_MS = 15_000;
const ATTENTION_REFRESH_MS = 5_000;

type DeliveryResult = "posted" | "duplicate" | "cancelled" | "suppressed";
type ClaimResult = "claimed" | Exclude<DeliveryResult, "posted">;
type Receipt = [key: string, expiresAt: number];

function openReceiptDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    let blocked = false;
    request.onupgradeneeded = () => {
      request.result.createObjectStore(RECEIPTS_STORE);
    };
    request.onsuccess = () => {
      if (blocked) {
        request.result.close();
      } else {
        resolve(request.result);
      }
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      blocked = true;
      reject(new Error("Notification receipt database is blocked"));
    };
  });
}

export function browserNotificationConversationKey(
  identity: NotificationIdentity | null | undefined,
  conversationId: string | null | undefined,
): string | null {
  return identity && conversationId
    ? JSON.stringify([identity.scopeId, identity.assistantId, conversationId])
    : null;
}

/** One instance per page; IndexedDB transactions serialize shared receipts. */
export class BrowserNotificationDelivery {
  private recent = new Map<string, number>();
  private recentSounds = new Map<string, number>();
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
    this.recentSounds.clear();
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(SOUND_STORAGE_KEY);
  }

  async post(
    key: string | null,
    deliver: () => void,
    canDeliver: () => boolean = () => true,
    conversationKey: string | null = null,
  ): Promise<DeliveryResult> {
    const result = await this.claim(
      "post", key, deliver, canDeliver, conversationKey,
    );
    return result === "claimed" ? "posted" : result;
  }

  /** Reserve web sound independently of whether the browser accepted a banner. */
  claimSound(
    key: string | null,
    canDeliver: () => boolean = () => true,
    conversationKey: string | null = null,
  ): Promise<ClaimResult> {
    return this.claim("sound", key, () => undefined, canDeliver, conversationKey);
  }

  private async claim(
    kind: "post" | "sound",
    key: string | null,
    deliver: () => void,
    canDeliver: () => boolean,
    conversationKey: string | null,
  ): Promise<ClaimResult> {
    const storageKey = kind === "post" ? STORAGE_KEY : SOUND_STORAGE_KEY;
    const recent = kind === "post" ? this.recent : this.recentSounds;
    const claim = (storedReceipts?: unknown): ClaimResult => {
      if (!canDeliver()) {
        return "cancelled";
      }
      if (this.isConversationAttended(conversationKey)) {
        return "suppressed";
      }
      if (!key) {
        deliver();
        return "claimed";
      }
      const now = Date.now();
      const receiptSources: unknown[] = [storedReceipts];
      try {
        receiptSources.push(JSON.parse(
          localStorage.getItem(storageKey) ?? "[]",
        ));
      } catch (error) {
        captureError(error, { context: "browser_notification.read_receipts" });
      }
      for (const value of receiptSources) {
        if (Array.isArray(value)) {
          const receipts = value
            .filter((entry): entry is Receipt =>
              Array.isArray(entry) &&
              entry.length === 2 &&
              typeof entry[0] === "string" &&
              typeof entry[1] === "number" &&
              entry[1] > now,
            )
            .slice(-MAX_DELIVERIES);
          for (const [receiptKey, expiresAt] of receipts) {
            recent.set(receiptKey, Math.max(expiresAt, recent.get(receiptKey) ?? 0));
          }
        }
      }
      const currentReceipts = [...recent]
        .filter(([, expiresAt]) => expiresAt > now)
        .sort((first, second) => first[1] - second[1])
        .slice(-MAX_DELIVERIES);
      recent.clear();
      for (const [receiptKey, expiresAt] of currentReceipts) {
        recent.set(receiptKey, expiresAt);
      }
      if (recent.has(key)) {
        return "duplicate";
      }
      // A throwing browser post retains no receipt so another tab can retry.
      deliver();
      recent.set(key, now + RETENTION_MS);
      if (recent.size > MAX_DELIVERIES) {
        const oldest = recent.keys().next().value;
        if (oldest !== undefined) {
          recent.delete(oldest);
        }
      }
      try {
        localStorage.setItem(storageKey, JSON.stringify([...recent]));
      } catch (error) {
        captureError(error, { context: "browser_notification.write_receipts" });
      }
      return "claimed";
    };

    if (key && typeof indexedDB !== "undefined") {
      let enteredClaim = false;
      try {
        const db = await openReceiptDatabase();
        try {
          return await new Promise<ClaimResult>((resolve, reject) => {
            const transaction = db.transaction(RECEIPTS_STORE, "readwrite");
            const store = transaction.objectStore(RECEIPTS_STORE);
            const request = store.get(storageKey);
            let result: ClaimResult | undefined;
            let claimError: unknown;
            request.onsuccess = () => {
              enteredClaim = true;
              try {
                result = claim(request.result);
                if (result === "claimed" || result === "duplicate") {
                  store.put([...recent], storageKey);
                }
              } catch (error) {
                claimError = error;
                transaction.abort();
              }
            };
            transaction.oncomplete = () => {
              if (result === undefined) {
                reject(new Error("Notification receipt transaction completed without a claim"));
              } else {
                resolve(result);
              }
            };
            transaction.onabort = () => {
              const error = claimError ?? transaction.error;
              if (result === undefined) {
                reject(error);
              } else {
                // The side effect already ran; keep its in-page receipt and
                // never retry it because durable storage failed to commit.
                captureError(error, { context: "browser_notification.commit_receipt" });
                resolve(result);
              }
            };
          });
        } finally {
          db.close();
        }
      } catch (error) {
        if (enteredClaim) {
          throw error;
        }
        captureError(error, { context: "browser_notification.open_receipts" });
      }
    }

    if (key && typeof navigator !== "undefined" && navigator.locks?.request) {
      let enteredClaim = false;
      try {
        return await navigator.locks.request(storageKey, () => {
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
    // Browsers without IndexedDB retain best-effort coordination and an OS tag.
    return claim();
  }
}

export const browserNotificationDelivery = new BrowserNotificationDelivery();
