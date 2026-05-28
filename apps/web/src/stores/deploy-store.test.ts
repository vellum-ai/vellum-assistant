import { beforeEach, describe, it, expect } from "bun:test";

import { useDeployStore } from "@/stores/deploy-store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getState() {
  return useDeployStore.getState();
}

beforeEach(() => {
  getState().reset();
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
    useDeployStore.setState({ complexDeployApp: { appId: "app-1", name: "My App" } });
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
