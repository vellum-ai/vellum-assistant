/**
 * Thin haptic-feedback wrapper. On native Capacitor platforms this delegates
 * to `@capacitor/haptics`; on web it's a no-op. The lazy import ensures the
 * Capacitor plugin's `registerPlugin()` call (which throws without the full
 * runtime) never runs in a plain browser context.
 */
export const haptic = {
  light: async () => {
    /* no-op until Capacitor is integrated */
  },
  medium: async () => {
    /* no-op until Capacitor is integrated */
  },
  success: async () => {
    /* no-op until Capacitor is integrated */
  },
  error: async () => {
    /* no-op until Capacitor is integrated */
  },
};
