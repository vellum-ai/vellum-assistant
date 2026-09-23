import { BrowserNotificationDelivery } from "../../src/runtime/browser-notification-delivery";
import { publishVisibilitySource } from "../../src/runtime/event-sources/dom-visibility";
import { isClientAttended } from "../../src/runtime/window-attention";

const delivery = new BrowserNotificationDelivery();
const posted: string[] = [];
publishVisibilitySource();
let stopAttention: (() => void) | undefined;

const fixture = {
  posted,
  setAttention: (attended: boolean) => {
    // Headless pages can all report focused; drive their DOM attention input.
    document.hasFocus = () => attended;
    Object.defineProperty(document, "visibilityState", {
      configurable: true, get: () => attended ? "visible" : "hidden",
    });
    window.dispatchEvent(new Event(attended ? "focus" : "blur"));
    document.dispatchEvent(new Event("visibilitychange"));
  },
  watchConversation: (key: string | null) => {
    stopAttention?.();
    stopAttention = key
      ? delivery.trackAttention(() => isClientAttended() ? key : null)
      : undefined;
  },
  isAttended: (key: string) => delivery.isConversationAttended(key),
  claimSound: (key: string) => delivery.claimSound(key),
  deliver: async (key: string, fail = false, currentSession = true, conversationKey: string | null = null) => {
    try {
      return await delivery.post(key, () => {
        if (fail) {
          throw new Error("Notification refused");
        }
        // The OS surface is stubbed; coordination uses actual browser APIs.
        posted.push(key);
      }, () => currentSession, conversationKey);
    } catch {
      return "failed";
    }
  },
};

window.notificationDeliveryTest = fixture;

declare global {
  interface Window {
    notificationDeliveryTest: typeof fixture;
  }
}
