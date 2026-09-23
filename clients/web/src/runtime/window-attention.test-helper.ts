export function stubBrowserAttention() {
  const visibilityDescriptor = Object.getOwnPropertyDescriptor(
    document,
    "visibilityState",
  );
  const originalHasFocus = document.hasFocus;

  return {
    set({ visible, focused }: { visible: boolean; focused: boolean }): void {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: visible ? "visible" : "hidden",
      });
      document.hasFocus = () => focused;
    },
    restore(): void {
      if (visibilityDescriptor) {
        Object.defineProperty(
          document,
          "visibilityState",
          visibilityDescriptor,
        );
      } else {
        Reflect.deleteProperty(document, "visibilityState");
      }
      document.hasFocus = originalHasFocus;
    },
  };
}
