import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";

import { useAuthStore, setupAuthListeners } from "@/stores/auth-store.js";
import { setupOrganizationStore } from "@/stores/organization-store.js";
import { AppProviders } from "@/components/providers.js";
import { installVellumDebugApi } from "@/domains/chat/api/debug-api.js";
import { router } from "./routes.js";

import "@/lib/sentry/sentry-init.js";
import "@/lib/api-interceptors.js";
import "./index.css";

import { initSafeAreaBridge } from "@/runtime/native-safe-area.js";

async function boot() {
  await initSafeAreaBridge();

  // Attach `window._vellumDebug.events` for in-DevTools SSE inspection.
  // Idempotent + SSR-safe; sibling `.chat` namespace is installed later
  // when the chat page mounts.
  installVellumDebugApi();

  setupOrganizationStore();
  useAuthStore.getState().initSession();
  setupAuthListeners();

  const rootEl = document.getElementById("root");
  if (!rootEl) throw new Error("Root element #root not found");

  createRoot(rootEl).render(
    <StrictMode>
      <AppProviders>
        <RouterProvider router={router} />
      </AppProviders>
    </StrictMode>,
  );
}

boot();
