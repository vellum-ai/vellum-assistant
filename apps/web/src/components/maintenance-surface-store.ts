import { useEffect } from "react";
import { create } from "zustand";

/**
 * Presence registry for mounted maintenance surfaces (the actionable
 * Recovery Mode card). `StatusBanner` suppresses its own operational
 * `maintenance_mode` notice only while a surface is actually rendered.
 * Mount-location proxies can't answer that: read-only channel
 * conversations render no composer (so no card) on a matching chat
 * route, and gated platform modes render no card at all.
 *
 * A count, not a boolean, so overlapping mounts during route
 * transitions can't clear each other's registration.
 */
const useMaintenanceSurfaceStore = create<{ count: number }>(() => ({
  count: 0,
}));

export function useRegisterMaintenanceSurface(rendered: boolean): void {
  useEffect(() => {
    if (!rendered) return;
    useMaintenanceSurfaceStore.setState((s) => ({ count: s.count + 1 }));
    return () =>
      useMaintenanceSurfaceStore.setState((s) => ({ count: s.count - 1 }));
  }, [rendered]);
}

export function useHasMaintenanceSurface(): boolean {
  return useMaintenanceSurfaceStore((s) => s.count > 0);
}
