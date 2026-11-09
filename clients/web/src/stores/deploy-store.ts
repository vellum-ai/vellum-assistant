/**
 * Zustand store for the app share/deploy lifecycle.
 *
 * Owns the in-flight UI state for two operations:
 * - **Share** — export an app to a `.vellum` bundle.
 * - **Deploy**: publish an app through whichever target the assistant is
 *   configured for (with an intermediate token dialog when that target is
 *   Vercel and no Vercel token is stored yet).
 *
 * Used by both the chat-page app viewer and the library page — lives
 * in `stores/` because it is cross-domain shared state.
 *
 * Reference: {@link https://zustand.docs.pmnd.rs/}
 */

import { create } from "zustand";

import type { AppsByIdPublishPostResponse } from "@/generated/daemon/types.gen";
import { t } from "@/i18n";
import { createSelectors } from "@/utils/create-selectors";
import { publishApp } from "@/utils/publish-app";
import {
  isVercelPublishProvider,
  publishProviderName,
} from "@/utils/publish-provider";
import { shareAppWithToast } from "@/utils/share-app-with-toast";
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
  shareApp: (
    assistantId: string,
    appId: string,
    appName: string,
  ) => Promise<void>;
  deployApp: (
    assistantId: string,
    appId: string,
    appName: string,
    appHtml: string,
  ) => Promise<void>;
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

/**
 * Whether the failure is one the Vercel token dialog can fix. Only consulted
 * for the Vercel provider: every other target reports a missing credential (or
 * a missing endpoint) as an ordinary error with a message that says what to do.
 */
function isCredentialError(result: AppsByIdPublishPostResponse): boolean {
  return (
    result.errorCode === "credentials_missing" ||
    !!result.error?.includes("not allowed to use credential") ||
    !!result.error?.includes("domain restrictions") ||
    !!result.error?.includes("Credential use failed")
  );
}

function handlePublishResult(result: AppsByIdPublishPostResponse): {
  needsVercelToken: boolean;
} {
  if (!result.success) {
    if (isVercelPublishProvider(result) && isCredentialError(result)) {
      return { needsVercelToken: true };
    }
    toast.error(t("deployStore.deployFailed"), { description: result.error });
    return { needsVercelToken: false };
  }

  const provider = publishProviderName(result);
  if (result.publicUrl) {
    toast.success(t("deployStore.deployedToProvider", { provider }), {
      description: result.publicUrl,
      action: {
        label: t("deployStore.open"),
        onClick: () => window.open(result.publicUrl, "_blank"),
      },
    });
  } else {
    toast.success(t("deployStore.deployedToProvider", { provider }));
  }
  return { needsVercelToken: false };
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
    if (get().isSharing) {
      return;
    }
    set({ isSharing: true });
    try {
      await shareAppWithToast(
        assistantId,
        { id: appId, name: appName },
        {
          exported: t("deployStore.appExported"),
          failed: t("deployStore.shareFailed"),
        },
      );
    } finally {
      set({ isSharing: false });
    }
  },

  deployApp: async (assistantId, appId, appName, appHtml) => {
    if (get().isDeploying) {
      return;
    }
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
      // The publish route answers a missing credential before it compiles the
      // app, so asking it is the cheap way to learn both whether a credential
      // is needed and which provider needs it.
      const result = await publishApp(assistantId, appId);
      if (handlePublishResult(result).needsVercelToken) {
        set({
          isTokenDialogOpen: true,
          pendingDeployAppId: appId,
          isDeploying: false,
        });
      }
    } catch (err) {
      toast.error(t("deployStore.deployFailed"), {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      set({ isDeploying: false });
    }
  },

  deployAfterTokenSaved: async (assistantId) => {
    const { pendingDeployAppId } = get();
    set({ isTokenDialogOpen: false });
    if (!pendingDeployAppId) {
      return;
    }
    set({ isDeploying: true });
    try {
      // The token the user just saved is the one that failed, so a second
      // credential error is reported rather than reopening the dialog.
      const result = await publishApp(assistantId, pendingDeployAppId);
      if (handlePublishResult(result).needsVercelToken) {
        toast.error(t("deployStore.deployFailed"), {
          description: result.error,
        });
      }
    } catch (err) {
      toast.error(t("deployStore.deployFailed"), {
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
