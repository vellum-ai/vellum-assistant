import { Capacitor } from "@capacitor/core";
import { SafeArea } from "capacitor-plugin-safe-area";

function applyInsets(insets: {
  top: number;
  right: number;
  bottom: number;
  left: number;
}) {
  const style = document.documentElement.style;
  style.setProperty("--safe-area-inset-top", `${insets.top}px`);
  style.setProperty("--safe-area-inset-right", `${insets.right}px`);
  style.setProperty("--safe-area-inset-bottom", `${insets.bottom}px`);
  style.setProperty("--safe-area-inset-left", `${insets.left}px`);
}

let initialized = false;

export async function initSafeAreaBridge(): Promise<void> {
  if (initialized) return;
  if (typeof window === "undefined" || !Capacitor.isNativePlatform()) return;
  initialized = true;

  try {
    const { insets } = await SafeArea.getSafeAreaInsets();
    applyInsets(insets);
  } catch {
    // Plugin unavailable or not registered — fall through to env() fallback.
  }

  try {
    await SafeArea.addListener("safeAreaChanged", ({ insets }) => {
      applyInsets(insets);
    });
  } catch {
    // Listener registration failed — initial insets are still applied.
  }
}
