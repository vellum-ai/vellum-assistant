// Run localStorage migrations before any other app import.
// MUST stay above the routes import — routes → onboarding-store and
// client-feature-flag-store read localStorage at module level.
import "@/utils/run-storage-migrations";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import * as Sentry from "@sentry/react";

import { initSentry } from "@/lib/sentry/sentry-init";
import { isLocalMode, loadLockfile } from "@/lib/local-mode";
import { useAuthStore, setupAuthListeners } from "@/stores/auth-store";
import { setupOrganizationStore } from "@/stores/organization-store";
import { AppProviders } from "@/components/providers";
import { isChunkLoadError } from "@/lib/chunk-errors";
import { router } from "./routes";

import "@/lib/api-interceptors";
import "./index.css";

import { initSafeAreaBridge } from "@/runtime/native-safe-area";

async function boot() {
  await initSafeAreaBridge();
  initSentry();

  setupOrganizationStore();
  if (isLocalMode()) {
    await loadLockfile();
    await useAuthStore.getState().initSession();
  } else {
    useAuthStore.getState().initSession();
  }
  setupAuthListeners();

  const rootEl = document.getElementById("root");
  if (!rootEl) throw new Error("Root element #root not found");

  createRoot(rootEl).render(
    <StrictMode>
      <AppProviders>
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
