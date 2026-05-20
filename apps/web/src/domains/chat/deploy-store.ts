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

import { toast } from "@vellum/design-library";
import { shareApp as shareAppApi } from "@/domains/chat/api/apps.js";
import { getVercelConfig, isCredentialError, publishApp } from "@/domains/chat/api/publish.js";
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
  shareApp: (assistantId: string, appId: string, appName: string) => Promise<void>;
  startDeploying: () => void;
  finishDeploying: (clearPendingAppId?: boolean) => void;
  deployApp: (assistantId: string, appId: string, appName: string, appHtml: string) => Promise<void>;
  deployAfterTokenSaved: (assistantId: string) => Promise<void>;
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

const useDeployStoreBase = create<DeployStore>()((set, get) => ({
  ...INITIAL_STATE,

  startSharing: () => {
    set({ isSharing: true });
  },

  finishSharing: () => {
    set({ isSharing: false });
  },

  shareApp: async (assistantId, appId, appName) => {
    if (get().isSharing) return;
    set({ isSharing: true });
    try {
      await shareAppApi(assistantId, appId, appName);
      toast.success("App exported", { description: `${appName}.vellum` });
    } catch (err) {
      toast.error("Failed to share app", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      set({ isSharing: false });
    }
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

  deployApp: async (assistantId, appId, appName, appHtml) => {
    if (get().isDeploying) return;
    if (
      appHtml.includes("vellum.fetch") ||
      appHtml.includes("vellum.sendAction") ||
      appHtml.includes("/v1/x/") ||
      appHtml.includes("/v1/apps/")
    ) {
      set({ complexDeployApp: { appId, name: appName } });
      return;
    }
    set({ isDeploying: true });
    try {
      const config = await getVercelConfig(assistantId);
      if (!config.hasToken) {
        set({ isTokenDialogOpen: true, pendingDeployAppId: appId, isDeploying: false });
        return;
      }
      const result = await publishApp(assistantId, appId);
      if (!result.success) {
        if (isCredentialError(result)) {
          set({ isTokenDialogOpen: true, pendingDeployAppId: appId, isDeploying: false });
        } else {
          toast.error("Failed to deploy", { description: result.error });
        }
      } else if (result.publicUrl) {
        toast.success("Deployed to Vercel", {
          description: result.publicUrl,
          action: {
            label: "Open",
            onClick: () => window.open(result.publicUrl, "_blank"),
          },
        });
      } else {
        toast.success("Deployed to Vercel");
      }
    } catch (err) {
      toast.error("Failed to deploy", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      set({ isDeploying: false });
    }
  },

  deployAfterTokenSaved: async (assistantId) => {
    const { pendingDeployAppId } = get();
    set({ isTokenDialogOpen: false });
    if (!pendingDeployAppId) return;
    set({ isDeploying: true });
    try {
      const result = await publishApp(assistantId, pendingDeployAppId);
      if (!result.success) {
        toast.error("Failed to deploy", { description: result.error });
      } else if (result.publicUrl) {
        toast.success("Deployed to Vercel", {
          description: result.publicUrl,
          action: {
            label: "Open",
            onClick: () => window.open(result.publicUrl, "_blank"),
          },
        });
      } else {
        toast.success("Deployed to Vercel");
      }
    } catch (err) {
      toast.error("Failed to deploy", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      set({ isDeploying: false, pendingDeployAppId: null });
    }
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
