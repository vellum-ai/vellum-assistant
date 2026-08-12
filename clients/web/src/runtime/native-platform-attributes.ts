import {
  isNativeAndroid,
  isNativeIOS,
} from "@/runtime/platform-detection";

/**
 * Stamp the native platform on <html> so CSS can gate shell-specific styling
 * (the `native-mobile` variant in index.css keys off it). Called
 * synchronously from main.tsx boot() before createRoot so the attribute
 * is present for the first paint. The attribute write is idempotent, so
 * no init latch is needed (unlike initInputModality / initSafeAreaBridge,
 * which register listeners).
 */
export function initNativePlatformAttributes(): void {
  if (typeof document === "undefined") {
    return;
  }
  if (isNativeIOS()) {
    document.documentElement.dataset.nativePlatform = "ios";
  } else if (isNativeAndroid()) {
    document.documentElement.dataset.nativePlatform = "android";
  }
}
