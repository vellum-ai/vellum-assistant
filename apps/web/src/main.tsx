import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";

import { useAuthStore, setupAuthListeners } from "@/stores/auth-store.js";
import { useOrganizationStore } from "@/stores/organization-store.js";
import { AppProviders } from "@/components/providers.js";
import { router } from "./routes.js";

import "@/lib/api-interceptors.js";
import "./index.css";

useAuthStore.subscribe((state, prevState) => {
  if (
    state.isLoggedIn &&
    (!prevState.isLoggedIn || state.user?.id !== prevState.user?.id)
  ) {
    useOrganizationStore.getState().fetchOrganizations();
  }
});

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
