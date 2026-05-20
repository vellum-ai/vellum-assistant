
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import type { AppSummary } from "@/domains/chat/api/apps.js";
import {
  loadPinnedApps,
  pinApp,
  unpinApp,
  type PinnedAppEntry,
} from "@/domains/chat/utils/appPinStorage.js";

// ---------------------------------------------------------------------------
// Pinned apps context — single source of truth for chat-side pin state.
//
// Replaces a 5-component prop-drill (Transcript → TranscriptRow →
// TranscriptMessageBody → SurfaceRouter → DynamicPageSurface) plus a separate
// path for non-inline panel surfaces. Anywhere in the provider's subtree can
// read pinned state and toggle it without threading callbacks.
//
// Storage is localStorage; we expose a tiny pub/sub so multiple consumers in
// the tree stay in sync after `togglePin` and so the SSR snapshot stays empty
// (avoiding hydration mismatch).
// ---------------------------------------------------------------------------

const listeners = new Set<() => void>();
const unpinListeners = new Set<(appId: string) => void>();

const SERVER_SNAPSHOT: PinnedAppEntry[] = [];

// useSyncExternalStore requires getSnapshot to return a stable reference
// until subscribers are notified. We cache the parsed array and invalidate
// only on emitChange (i.e. an actual togglePin write).
let cachedSnapshot: PinnedAppEntry[] | null = null;

function emitChange() {
  cachedSnapshot = null;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getClientSnapshot(): PinnedAppEntry[] {
  if (cachedSnapshot == null) {
    cachedSnapshot = loadPinnedApps();
  }
  return cachedSnapshot;
}

function getServerSnapshot(): PinnedAppEntry[] {
  return SERVER_SNAPSHOT;
}

export interface PinnedAppsContextValue {
  /** Ordered list of pinned entries (for SideMenu rendering). */
  pinnedApps: PinnedAppEntry[];
  /** O(1) lookup set of pinned app ids. */
  pinnedAppIds: Set<string>;
  /** Toggle: pins if absent, unpins if present. Notifies subscribers. */
  togglePin: (app: AppSummary) => void;
  /** Convenience predicate. */
  isPinned: (appId: string) => boolean;
  /** Subscribe to ad-hoc unpin events (e.g. to navigate away if the active
   *  app was just unpinned). The callback fires with the unpinned id. */
  onUnpin: (listener: (appId: string) => void) => () => void;
}

const PinnedAppsContext = createContext<PinnedAppsContextValue | null>(null);

interface PinnedAppsProviderProps {
  children: ReactNode;
}

export function PinnedAppsProvider({ children }: PinnedAppsProviderProps) {
  // useSyncExternalStore handles SSR (`[]`), hydration, and cross-component
  // synchronization in one shot — no setState-in-effect lint complaint and
  // no manual hydration effect.
  const pinnedApps = useSyncExternalStore(
    subscribe,
    getClientSnapshot,
    getServerSnapshot,
  );

  // useState for the listener-set ref so we keep a stable identity across
  // renders (avoid re-creating the set on every commit).
  const [unpinSubscribers] = useState(() => unpinListeners);

  const togglePin = useCallback((app: AppSummary) => {
    const wasPinned = loadPinnedApps().some((e) => e.appId === app.id);
    if (wasPinned) {
      unpinApp(app.id);
    } else {
      pinApp(app);
    }
    emitChange();
    if (wasPinned) {
      for (const listener of unpinSubscribers) listener(app.id);
    }
  }, [unpinSubscribers]);

  const onUnpin = useCallback((listener: (id: string) => void) => {
    unpinSubscribers.add(listener);
    return () => {
      unpinSubscribers.delete(listener);
    };
  }, [unpinSubscribers]);

  const value = useMemo<PinnedAppsContextValue>(() => {
    const ids = new Set(pinnedApps.map((a) => a.appId));
    return {
      pinnedApps,
      pinnedAppIds: ids,
      togglePin,
      isPinned: (appId: string) => ids.has(appId),
      onUnpin,
    };
  }, [pinnedApps, togglePin, onUnpin]);

  return (
    <PinnedAppsContext value={value}>
      {children}
    </PinnedAppsContext>
  );
}

/**
 * Read pinned-app state. Throws if used outside `<PinnedAppsProvider>` so
 * misconfigured trees fail loudly instead of silently no-oping.
 */
export function usePinnedApps(): PinnedAppsContextValue {
  const ctx = useContext(PinnedAppsContext);
  if (ctx == null) {
    throw new Error(
      "usePinnedApps must be used inside a <PinnedAppsProvider>.",
    );
  }
  return ctx;
}

/**
 * Optional variant for components rendered in trees that may or may not have
 * a provider (e.g. shared primitives). Returns null when no provider is
 * present; the caller is responsible for handling the absence.
 */
export function usePinnedAppsOptional(): PinnedAppsContextValue | null {
  return useContext(PinnedAppsContext);
}
