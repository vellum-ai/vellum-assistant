// Run localStorage migrations before any other app import.
// MUST stay above the routes import — routes → onboarding-store and
// client-feature-flag-store read localStorage at module level.
import "@/utils/run-storage-migrations";

import * as Sentry from "@sentry/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";

import { AppProviders } from "@/components/providers";
import {
  STARTUP_FAILURE_MESSAGE,
  STARTUP_FAILURE_TITLE,
  StartupFailure,
} from "@/components/startup-failure";
import { WindowDragRegion } from "@/components/window-drag-region";
import { initI18n } from "@/i18n";
import { isChunkLoadError } from "@/lib/chunk-errors";
import { setupClientFlagScopeSync } from "@/lib/feature-flags/client-flag-scope";
import { installConsentRefreshListeners } from "@/lib/consent/consent-refresh";
import { isLocalClient, loadLockfile } from "@/lib/local-mode";
import { captureError } from "@/lib/sentry/capture-error";
import { initSentry } from "@/lib/sentry/sentry-init";
import { markBoot } from "@/lib/telemetry/boot-telemetry";
import { installTranslateDomGuard } from "@/lib/translate-dom-guard";
import { initSessionReplay } from "@/lib/session-replay/session-replay-init";
import { setupPlatformAssistantsSync } from "@/assistant/platform-assistants-sync";
import { setupAuthListeners, useAuthStore } from "@/stores/auth-store";
import { setupOrganizationStore } from "@/stores/organization-store";
import { router } from "./routes";

import "@/lib/api-interceptors";
import "./index.css";

import { initNativeKeyboard } from "@/runtime/native-keyboard";
import { initNativePlatformAttributes } from "@/runtime/native-platform-attributes";
import { initSafeAreaBridge } from "@/runtime/native-safe-area";
import { restorePendingNativeLogin } from "@/runtime/native-auth";
import { markNativeLaunchScreenReady } from "@/runtime/native-launch-screen";
import { initInputModality } from "@vellumai/design-library";

async function boot() {
  // Install before React first commits so the reconciler survives DOM
  // mutations from browser page translation.
  installTranslateDomGuard();

  initInputModality();
  initNativePlatformAttributes();
  await initSafeAreaBridge();
  // First render waits on this bridge, so it is the first boot gate worth a
  // number. See `lib/telemetry/boot-telemetry.ts` for the mark family.
  markBoot("safe_area_ready");
  void initNativeKeyboard();
  initSentry();
  // Awaited before the first render so no component observes an uninitialized
  // i18next and no raw key path is ever painted. English is bundled in this
  // entry chunk, so the floor is reachable with no network; `initI18n` reports
  // and degrades to it when another locale's chunk cannot be fetched. The
  // guard here covers the rest: no i18n failure is worth a blank screen, and
  // rendering English beats rendering nothing.
  try {
    await initI18n();
  } catch (error) {
    captureError(error, { context: "init_i18n" });
  }
  try {
    await restorePendingNativeLogin();
  } catch (error) {
    Sentry.captureException(error, {
      tags: { context: "restore_pending_native_login" },
    });
  }
  initSessionReplay();
  installConsentRefreshListeners();

  setupOrganizationStore();
  // Register before initSession so no identity transition is missed: client
  // flags are evaluated per (user, org) and must be re-fetched, not re-read,
  // when either moves.
  setupClientFlagScopeSync();
  // Register before initSession so the boot `unknown → present` transition it
  // drives is caught and the platform assistants list is loaded.
  setupPlatformAssistantsSync();
  if (isLocalClient()) {
    await loadLockfile();
    await useAuthStore.getState().initSession();
  } else {
    useAuthStore.getState().initSession();
  }
  setupAuthListeners();
  // Local mode awaits the lockfile read and `initSession()` above, so this
  // separates "session was the boot cost" from "the app tree was".
  markBoot("session_ready");

  const rootEl = document.getElementById("root");
  if (!rootEl) {
    throw new Error("Root element #root not found");
  }

  markBoot("react_mount");
  createRoot(rootEl).render(
    <StrictMode>
      <Sentry.ErrorBoundary
        beforeCapture={(scope) => {
          scope.setTag("boundary", "app-startup");
        }}
        fallback={<StartupFailure />}
      >
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
                  boundary: isChunkLoadError(error)
                    ? "lazy-route"
                    : "route-render",
                },
              });
            }}
          />
        </AppProviders>
      </Sentry.ErrorBoundary>
    </StrictMode>,
  );
}

function showBootFailure(error: unknown): void {
  try {
    captureError(error, { context: "app_boot" });
  } catch (captureFailure) {
    console.error("Unable to report the startup failure", captureFailure);
  }
  void markNativeLaunchScreenReady("system");

  try {
    const root = document.getElementById("root");
    if (!root) {
      return;
    }
    const container = document.createElement("main");
    container.setAttribute("role", "alert");
    container.style.cssText =
      "min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;font-family:system-ui,sans-serif";
    const content = document.createElement("div");
    const heading = document.createElement("h1");
    heading.textContent = STARTUP_FAILURE_TITLE;
    const message = document.createElement("p");
    message.textContent = STARTUP_FAILURE_MESSAGE;
    const reload = document.createElement("button");
    reload.type = "button";
    reload.textContent = "Reload app";
    reload.addEventListener("click", () => window.location.reload());
    content.append(heading, message, reload);
    container.append(content);
    root.replaceChildren(container);
  } catch (renderError) {
    console.error("Unable to show the startup error", renderError);
  }
}

void boot().catch(showBootFailure);
