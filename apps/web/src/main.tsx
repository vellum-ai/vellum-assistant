import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";

import { useAuthStore, setupAuthListeners } from "@/stores/auth-store.js";
import { setupOrganizationStore } from "@/stores/organization-store.js";
import { AppProviders } from "@/components/providers.js";
import { router } from "./routes.js";

import "@/lib/sentry/sentry-init.js";
import "@/lib/api-interceptors.js";
import "./index.css";

import { initSafeAreaBridge } from "@/runtime/native-safe-area.js";

function isChunkLoadError(error: unknown): boolean {
  if (error instanceof TypeError && /dynamically imported module|importing a module script/i.test(error.message)) {
    return true;
  }
  const name = (error as { name?: string }).name;
  return name === "ChunkLoadError" || name === "DynamicImportError";
}

async function boot() {
  await initSafeAreaBridge();

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
            if (isChunkLoadError(error)) {
              window.location.reload();
              return;
            }
            console.error("[RouterProvider]", error);
          }}
        />
      </AppProviders>
    </StrictMode>,
  );
}

boot();
