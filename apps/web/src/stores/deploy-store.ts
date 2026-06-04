/**
 * Zustand store for the app share/deploy lifecycle.
 *
 * Owns the in-flight UI state for two operations:
 * - **Share** — export an app to a `.vellum` bundle.
 * - **Deploy** — publish an app to Vercel (with an intermediate token
 *   dialog when the org doesn't yet have a Vercel token stored).
 *
 * Used by both the chat-page app viewer and the library page — lives
 * in `stores/` because it is cross-domain shared state.
 *
 * Reference: {@link https://zustand.docs.pmnd.rs/}
 */

import { create } from "zustand";

import { integrationsVercelConfigGet } from "@/generated/daemon/sdk.gen";
import type { AppsByIdPublishPostResponse } from "@/generated/daemon/types.gen";
import { createSelectors } from "@/utils/create-selectors";
import { publishApp } from "@/utils/publish-app";
import { shareApp as shareAppApi } from "@/utils/share-app";
import { toast } from "@vellumai/design-library";

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
  shareApp: (assistantId: string, appId: string, appName: string) => Promise<void>;
  deployApp: (assistantId: string, appId: string, appName: string, appHtml: string) => Promise<void>;
  deployAfterTokenSaved: (assistantId: string) => Promise<void>;
  showTokenDialog: (pendingAppId: string) => void;
  hideTokenDialog: () => void;
  setComplexDeployApp: (app: ComplexDeployApp | null) => void;
  reset: () => void;
}

export type DeployStore = DeployState & DeployActions;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isCredentialError(result: AppsByIdPublishPostResponse): boolean {
  return (
    result.errorCode === "credentials_missing" ||
    !!result.error?.includes("not allowed to use credential") ||
    !!result.error?.includes("domain restrictions") ||
    !!result.error?.includes("Credential use failed")
  );
}

function showPublishResultToast(result: AppsByIdPublishPostResponse): void {
  if (result.publicUrl) {
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
}

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
      const { data: config } = await integrationsVercelConfigGet({
        path: { assistant_id: assistantId },
        throwOnError: true,
      });
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
      } else {
        showPublishResultToast(result);
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
      } else {
        showPublishResultToast(result);
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
