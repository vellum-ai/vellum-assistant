import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import * as Sentry from "@sentry/react";

import { migrateDeviceSettings } from "@/lib/device-settings";
import { initSentry } from "@/lib/sentry/sentry-init";
import { useAuthStore, setupAuthListeners } from "@/stores/auth-store";
import { setupOrganizationStore } from "@/stores/organization-store";
import { AppProviders } from "@/components/providers";
import { router } from "./routes";

import "@/lib/api-interceptors";
import "./index.css";

import { initSafeAreaBridge } from "@/runtime/native-safe-area";

async function boot() {
  await initSafeAreaBridge();
  migrateDeviceSettings();
  initSentry();

  setupOrganizationStore();
  useAuthStore.getState().initSession();
  setupAuthListeners();

  const rootEl = document.getElementById("root");
  if (!rootEl) throw new Error("Root element #root not found");

  createRoot(rootEl).render(
    <StrictMode>
      <AppProviders>
        <RouterProvider
          router={router}
          onError={(error) => {
            Sentry.captureException(error, {
              tags: { context: "RouterProvider" },
            });
          }}
        />
      </AppProviders>
    </StrictMode>,
  );
}

boot();
