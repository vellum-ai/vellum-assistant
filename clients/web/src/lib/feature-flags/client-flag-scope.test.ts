/**
 * Tests for the flag-scope watcher — in particular the anonymous → signed-in
 * hand-off, where the pre-auth evaluation and the authenticated one can
 * legitimately disagree and the pre-auth answer must not be read as settled.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  currentClientFlagScopeKey,
  setupClientFlagScopeSync,
} from "@/lib/feature-flags/client-flag-scope";
import { useAuthStore } from "@/stores/auth-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useOrganizationStore } from "@/stores/organization-store";

const initialAuthState = useAuthStore.getState();
const initialOrganizationState = useOrganizationStore.getState();
const initialFlagState = useClientFeatureFlagStore.getState();

let teardown: (() => void) | null = null;

function signIn(userId: string) {
  useAuthStore.setState({
    sessionStatus: "authenticated",
    user: {
      kind: "platform",
      id: userId,
      username: null,
      email: null,
      isStaff: false,
      firstName: "",
      lastName: "",
    },
  });
}

beforeEach(() => {
  localStorage.clear();
  useAuthStore.setState(initialAuthState, true);
  useOrganizationStore.setState(initialOrganizationState, true);
  useClientFeatureFlagStore.setState(initialFlagState, true);
});

afterEach(() => {
  teardown?.();
  teardown = null;
});

describe("currentClientFlagScopeKey", () => {
  test("reports the anonymous scope with no session", () => {
    useAuthStore.setState({ sessionStatus: "unauthenticated", user: null });
    expect(currentClientFlagScopeKey()).toBe("anonymous:org:none");
  });

  test("reports the user and org once both resolve", () => {
    signIn("user-123");
    useOrganizationStore.setState({ currentOrganizationId: "org-abc" });
    expect(currentClientFlagScopeKey()).toBe("user:user-123:org:org-abc");
  });
});

describe("setupClientFlagScopeSync", () => {
  test("un-settles an anonymous evaluation when the visitor signs in", () => {
    useAuthStore.setState({ sessionStatus: "unauthenticated", user: null });
    teardown = setupClientFlagScopeSync();
    // The `/account/*` screens sync flags for anonymous visitors: the flag
    // evaluates off for a signed-out context and the store settles on it.
    useClientFeatureFlagStore
      .getState()
      .setFlags({ marketingPricingTakeover: false });
    expect(useClientFeatureFlagStore.getState().hydrated).toBe(true);

    signIn("user-123");

    // The signed-in evaluation hasn't landed yet, so nothing is settled and a
    // redirect-on-flag surface reads "pending" instead of bouncing.
    expect(useClientFeatureFlagStore.getState().hydrated).toBe(false);
  });

  test("takes the authenticated evaluation over the anonymous one", () => {
    useAuthStore.setState({ sessionStatus: "unauthenticated", user: null });
    teardown = setupClientFlagScopeSync();
    useClientFeatureFlagStore
      .getState()
      .setFlags({ marketingPricingTakeover: false });

    signIn("user-123");
    useOrganizationStore.setState({ currentOrganizationId: "org-abc" });
    useClientFeatureFlagStore
      .getState()
      .setFlags({ marketingPricingTakeover: true });

    const state = useClientFeatureFlagStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.marketingPricingTakeover).toBe(true);
  });

  test("drops an anonymous `true` rather than letting it stand for the user", () => {
    useAuthStore.setState({ sessionStatus: "unauthenticated", user: null });
    teardown = setupClientFlagScopeSync();
    useClientFeatureFlagStore
      .getState()
      .setFlags({ marketingPricingTakeover: true });

    signIn("user-123");

    const state = useClientFeatureFlagStore.getState();
    expect(state.marketingPricingTakeover).toBe(false);
    expect(state.hydrated).toBe(false);
  });

  test("re-opens hydration when the org resolves after the user", () => {
    signIn("user-123");
    teardown = setupClientFlagScopeSync();
    useClientFeatureFlagStore
      .getState()
      .setFlags({ marketingPricingTakeover: true });

    useOrganizationStore.setState({ currentOrganizationId: "org-abc" });

    expect(useClientFeatureFlagStore.getState().hydrated).toBe(false);
  });

  test("leaves a settled scope alone on unrelated auth store writes", () => {
    signIn("user-123");
    useOrganizationStore.setState({ currentOrganizationId: "org-abc" });
    teardown = setupClientFlagScopeSync();
    useClientFeatureFlagStore
      .getState()
      .setFlags({ marketingPricingTakeover: true });

    useAuthStore.setState({ platformSession: "present" });

    const state = useClientFeatureFlagStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.marketingPricingTakeover).toBe(true);
  });

  test("stops watching once torn down", () => {
    useAuthStore.setState({ sessionStatus: "unauthenticated", user: null });
    setupClientFlagScopeSync()();
    useClientFeatureFlagStore
      .getState()
      .setFlags({ marketingPricingTakeover: false });

    signIn("user-123");

    expect(useClientFeatureFlagStore.getState().hydrated).toBe(true);
  });
});
