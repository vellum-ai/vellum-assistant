import { captureError } from "@/lib/sentry/capture-error";

const STORAGE_KEY = "vellum:browser-notification-deliveries:v1";
const MAX_DELIVERIES = 128;
const RETENTION_MS = 10 * 60_000;

type DeliveryResult = "posted" | "duplicate" | "cancelled";
type Receipt = [key: string, expiresAt: number];

/** One instance per page; Web Locks serialize the same-origin receipt ledger. */
export class BrowserNotificationDelivery {
  private recent = new Map<string, number>();

  resetForTests(): void {
    this.recent.clear();
    localStorage.removeItem(STORAGE_KEY);
  }

  async post(
    key: string | null,
    deliver: () => void,
    canDeliver: () => boolean = () => true,
  ): Promise<DeliveryResult> {
    const claim = (): DeliveryResult => {
      if (!canDeliver()) {
        return "cancelled";
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
