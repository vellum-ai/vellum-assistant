// Run localStorage migrations before any other app import.
// MUST stay above the routes import — routes → onboarding-store and
// client-feature-flag-store read localStorage at module level.
import "@/utils/run-storage-migrations";

import * as Sentry from "@sentry/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";

import { AppProviders } from "@/components/providers";
import { WindowDragRegion } from "@/components/window-drag-region";
import { isChunkLoadError } from "@/lib/chunk-errors";
import { installConsentRefreshListeners } from "@/lib/consent/consent-refresh";
import { isLocalMode, loadLockfile } from "@/lib/local-mode";
import { initSentry } from "@/lib/sentry/sentry-init";
import { installTranslateDomGuard } from "@/lib/translate-dom-guard";
import { initSessionReplay } from "@/lib/session-replay/session-replay-init";
import { setupAuthListeners, useAuthStore } from "@/stores/auth-store";
import { setupOrganizationStore } from "@/stores/organization-store";
import { router } from "./routes";

import "@/lib/api-interceptors";
import "./index.css";

import { initSafeAreaBridge } from "@/runtime/native-safe-area";
import { initInputModality } from "@vellumai/design-library";

async function boot() {
  // Install before React first commits so the reconciler survives DOM
  // mutations from browser page translation.
  installTranslateDomGuard();

  initInputModality();
  await initSafeAreaBridge();
  initSentry();
  initSessionReplay();
  installConsentRefreshListeners();

  setupOrganizationStore();
  if (isLocalMode()) {
    await loadLockfile();
    await useAuthStore.getState().initSession();
  } else {
    useAuthStore.getState().initSession();
  }
  setupAuthListeners();

  const rootEl = document.getElementById("root");
  if (!rootEl) {
    throw new Error("Root element #root not found");
  }

  createRoot(rootEl).render(
    <StrictMode>
      <AppProviders>
        <WindowDragRegion />
        <RouterProvider
          router={router}
          onError={(error) => {
            // Single Sentry capture point for every router error.
            // `RouteErrorBoundary` (used at every layer of the tree) owns
            // only the UI variant and intentionally does NOT capture again
            // to avoid duplicate events.
            Sentry.captureException(error, {
              tags: {
                context: "RouterProvider",
                boundary: isChunkLoadError(error) ? "lazy-route" : "route-render",
              },
            });
          }}
        />
      </AppProviders>
    </StrictMode>,
  );
}

boot();
