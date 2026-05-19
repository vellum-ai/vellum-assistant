import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";

import { AuthProvider } from "@/lib/auth/auth-provider.js";
import { AppProviders } from "@/components/providers.js";
import { router } from "./routes.js";

import "@/lib/api-interceptors.js";
import "./index.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element #root not found");

createRoot(rootEl).render(
  <StrictMode>
    <AuthProvider>
      <AppProviders>
        <RouterProvider router={router} />
      </AppProviders>
    </AuthProvider>
  </StrictMode>,
);
