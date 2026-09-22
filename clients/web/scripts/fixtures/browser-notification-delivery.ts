import { BrowserNotificationDelivery } from "../../src/runtime/browser-notification-delivery";

const delivery = new BrowserNotificationDelivery();
const posted: string[] = [];

const fixture = {
  posted,
  deliver: async (key: string, fail = false, currentSession = true) => {
    try {
      return await delivery.post(key, () => {
        if (fail) {
          throw new Error("Notification refused");
        }
        // The OS surface is stubbed; coordination uses actual browser APIs.
        posted.push(key);
      }, () => currentSession);
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
