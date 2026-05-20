/**
 * Zustand store for the app share/deploy lifecycle.
 *
 * Owns the in-flight UI state for two operations on the app viewer:
 * - **Share** — export the current app to a `.vellum` bundle.
 * - **Deploy** — publish the app to Vercel (with an intermediate token
 *   dialog when the org doesn't yet have a Vercel token stored).
 *
 * Split out from `useViewerStore` because none of these fields relate
 * to navigation (`mainView`, `intelligenceTab`) or viewer lifecycle
 * (`openedAppState`, `openedDocumentState`); they form an independent
 * data concern and only ship together with the app-share/deploy code
 * paths.
 *
 * Reference: {@link https://zustand.docs.pmnd.rs/}
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ComplexDeployApp {
  appId: string;
  name: string;
}

// ---------------------------------------------------------------------------
// State & Actions
// ---------------------------------------------------------------------------

export interface DeployState {
  isSharing: boolean;
  isDeploying: boolean;
  isTokenDialogOpen: boolean;
  pendingDeployAppId: string | null;
  complexDeployApp: ComplexDeployApp | null;
}

export interface DeployActions {
  startSharing: () => void;
  finishSharing: () => void;
  startDeploying: () => void;
  finishDeploying: (clearPendingAppId?: boolean) => void;
  showTokenDialog: (pendingAppId: string) => void;
  hideTokenDialog: () => void;
  setComplexDeployApp: (app: ComplexDeployApp | null) => void;
  reset: () => void;
}

export type DeployStore = DeployState & DeployActions;

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

const INITIAL_STATE: DeployState = {
  isSharing: false,
  isDeploying: false,
  isTokenDialogOpen: false,
  pendingDeployAppId: null,
  complexDeployApp: null,
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const useDeployStoreBase = create<DeployStore>()((set) => ({
  ...INITIAL_STATE,

  startSharing: () => {
    set({ isSharing: true });
  },

  finishSharing: () => {
    set({ isSharing: false });
  },

  startDeploying: () => {
    set({ isDeploying: true });
  },

  finishDeploying: (clearPendingAppId) => {
    set({
      isDeploying: false,
      ...(clearPendingAppId ? { pendingDeployAppId: null } : {}),
    });
  },

  showTokenDialog: (pendingAppId) => {
    set({
      isTokenDialogOpen: true,
      pendingDeployAppId: pendingAppId,
      isDeploying: false,
    });
  },

  hideTokenDialog: () => {
    set({ isTokenDialogOpen: false });
  },

  setComplexDeployApp: (app) => {
    set({ complexDeployApp: app });
  },

  /**
   * Restore deploy/share state to its initial value. Does NOT reset viewer
   * state — that lives in `useViewerStore` and has its own `reset()`.
   * Callers that want a full UI reset should call both.
   */
  reset: () => set({ ...INITIAL_STATE }),
}));

export const useDeployStore = createSelectors(useDeployStoreBase);
