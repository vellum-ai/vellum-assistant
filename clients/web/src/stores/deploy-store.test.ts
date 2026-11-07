import { beforeEach, describe, it, expect, mock } from "bun:test";

import type { AppsByIdPublishPostResponse } from "@/generated/daemon/types.gen";

let publishResult: AppsByIdPublishPostResponse = { success: true };
const errorToasts: string[] = [];

mock.module("@/utils/publish-app", () => ({
  publishApp: async () => publishResult,
}));

mock.module("@vellumai/design-library/components/toast", () => ({
  Toaster: () => null,
  ToastContent: () => null,
  toast: {
    success: () => {},
    error: (_message: string, opts?: { description?: string }) => {
      errorToasts.push(opts?.description ?? "");
    },
  },
}));

const { useDeployStore } = await import("@/stores/deploy-store");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getState() {
  return useDeployStore.getState();
}

beforeEach(() => {
  getState().reset();
  publishResult = { success: true };
  errorToasts.length = 0;
});

// ---------------------------------------------------------------------------
// Token dialog
// ---------------------------------------------------------------------------

describe("showTokenDialog", () => {
  it("opens dialog, sets pending app, and stops deploying", () => {
    useDeployStore.setState({ isDeploying: true });
    getState().showTokenDialog("app-1");
    const state = getState();
    expect(state.isTokenDialogOpen).toBe(true);
    expect(state.pendingDeployAppId).toBe("app-1");
    expect(state.isDeploying).toBe(false);
  });
});

describe("hideTokenDialog", () => {
  it("closes the dialog", () => {
    useDeployStore.setState({ isTokenDialogOpen: true });
    getState().hideTokenDialog();
    expect(getState().isTokenDialogOpen).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Complex-deploy app
// ---------------------------------------------------------------------------

describe("setComplexDeployApp", () => {
  it("sets the complex deploy app", () => {
    const app = { appId: "app-1", name: "My App" };
    getState().setComplexDeployApp(app);
    expect(getState().complexDeployApp).toBe(app);
  });

  it("clears the complex deploy app when null", () => {
    useDeployStore.setState({
      complexDeployApp: { appId: "app-1", name: "My App" },
    });
    getState().setComplexDeployApp(null);
    expect(getState().complexDeployApp).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

describe("reset", () => {
  it("restores all state to defaults", () => {
    useDeployStore.setState({
      isSharing: true,
      isDeploying: true,
      isTokenDialogOpen: true,
      pendingDeployAppId: "app-1",
      complexDeployApp: { appId: "app-1", name: "My App" },
    });
    getState().reset();
    const state = getState();
    expect(state.isSharing).toBe(false);
    expect(state.isDeploying).toBe(false);
    expect(state.isTokenDialogOpen).toBe(false);
    expect(state.pendingDeployAppId).toBeNull();
    expect(state.complexDeployApp).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Which failures the Vercel token dialog claims
//
// The dialog can only fix a Vercel credential, so it is gated on the provider
// the publish response names. Every other target reports the failure as an
// ordinary error whose message says what to configure.
// ---------------------------------------------------------------------------

describe("deployApp credential failures", () => {
  it("opens the token dialog when Vercel has no credential", async () => {
    publishResult = {
      success: false,
      provider: "vercel",
      providerName: "Vercel",
      errorCode: "credentials_missing",
      error: "Vercel API token not configured",
    };

    await getState().deployApp("a-1", "app-1", "My App", "<html></html>");

    const state = getState();
    expect(state.isTokenDialogOpen).toBe(true);
    expect(state.pendingDeployAppId).toBe("app-1");
    expect(errorToasts).toEqual([]);
  });

  it("opens the token dialog for an assistant that names no provider", async () => {
    // Pre-dates pluggable providers, so it can only have meant Vercel.
    publishResult = {
      success: false,
      errorCode: "credentials_missing",
      error: "Vercel API token not configured",
    };

    await getState().deployApp("a-1", "app-1", "My App", "<html></html>");

    expect(getState().isTokenDialogOpen).toBe(true);
  });

  it("reports a webhook misconfiguration instead of asking for a Vercel token", async () => {
    publishResult = {
      success: false,
      provider: "webhook",
      providerName: "Webhook",
      errorCode: "deploy_failed",
      error: "apps.publish.webhook.url is not set",
    };

    await getState().deployApp("a-1", "app-1", "My App", "<html></html>");

    expect(getState().isTokenDialogOpen).toBe(false);
    expect(errorToasts).toEqual(["apps.publish.webhook.url is not set"]);
  });

  it("does not claim a webhook credential failure for the Vercel dialog", async () => {
    publishResult = {
      success: false,
      provider: "webhook",
      providerName: "Webhook",
      errorCode: "credentials_missing",
      error: "Publish webhook bearer token is not stored.",
    };

    await getState().deployApp("a-1", "app-1", "My App", "<html></html>");

    expect(getState().isTokenDialogOpen).toBe(false);
    expect(errorToasts).toEqual([
      "Publish webhook bearer token is not stored.",
    ]);
  });
});
