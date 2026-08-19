/**
 * Tests for `useSwitchableAssistants`: the gate (flag pair + gateway-auth
 * mode) and the list derivation (org validity, device reachability,
 * per-kind accessibility, and the two-entry floor) the sidebar switcher
 * renders from. The resolved-assistants and feature-flag stores are real;
 * the environment probes around them are mocked per test.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { cleanup, renderHook } from "@testing-library/react";

let localClient = false;
let remoteGatewayMode = false;
mock.module("@/lib/local-mode", () => ({
  isLocalClient: () => localClient,
  isRemoteGatewayMode: () => remoteGatewayMode,
  isLocalAssistant: (a: { cloud?: string }) =>
    a.cloud === "local" || a.cloud === "docker",
  isPairedAssistant: (a: { cloud?: string }) => a.cloud === "paired",
  isPlatformAssistant: (a: { cloud?: string }) => a.cloud === "vellum",
}));

let organizationId: string | null = "org-1";
mock.module("@/stores/organization-store", () => ({
  useRequestOrganizationId: () => organizationId,
}));

let hasPlatformSession = true;
mock.module("@/stores/auth-store", () => ({
  useHasPlatformSession: () => hasPlatformSession,
}));

const { useResolvedAssistantsStore } = await import(
  "@/stores/resolved-assistants-store"
);
const { useClientFeatureFlagStore } = await import(
  "@/stores/client-feature-flag-store"
);
const { useSwitchableAssistants } = await import(
  "@/assistant/use-switchable-assistants"
);

import type { ResolvedAssistant } from "@/stores/resolved-assistants-store";

const platform = (
  id: string,
  overrides: Partial<ResolvedAssistant> = {},
): ResolvedAssistant => ({
  id,
  name: id,
  isLocal: false,
  isPlatformHosted: true,
  isPaired: false,
  ...overrides,
});

function seed(assistants: ResolvedAssistant[]): void {
  useResolvedAssistantsStore.setState({ assistants, assistantsHydrated: true });
}

function run() {
  return renderHook(() => useSwitchableAssistants()).result.current;
}

beforeEach(() => {
  localClient = false;
  remoteGatewayMode = false;
  organizationId = "org-1";
  hasPlatformSession = true;
  seed([]);
  useClientFeatureFlagStore.setState({
    multiPlatformAssistant: false,
    assistantSwitcher: true,
  });
});

afterEach(() => {
  cleanup();
});

describe("useSwitchableAssistants gate", () => {
  test("closed with both flags off, whatever the list holds", () => {
    useClientFeatureFlagStore.setState({
      multiPlatformAssistant: false,
      assistantSwitcher: false,
    });
    seed([platform("a1"), platform("a2")]);

    expect(run().canSwitch).toBe(false);
  });

  test("either flag alone opens it", () => {
    seed([platform("a1"), platform("a2")]);
    expect(run().canSwitch).toBe(true);

    useClientFeatureFlagStore.setState({
      multiPlatformAssistant: true,
      assistantSwitcher: false,
    });
    expect(run().canSwitch).toBe(true);
  });

  test("remote-gateway mode closes it", () => {
    remoteGatewayMode = true;
    seed([platform("a1"), platform("a2")]);

    expect(run().canSwitch).toBe(false);
  });

  test("a single switchable assistant is not enough", () => {
    seed([platform("a1")]);

    expect(run().canSwitch).toBe(false);
  });
});

describe("useSwitchableAssistants list", () => {
  test("cross-org platform entries are dropped", () => {
    seed([
      platform("a1", { organizationId: "org-1" }),
      platform("a2", { organizationId: "org-2" }),
    ]);

    const { assistants, canSwitch } = run();
    expect(assistants.map((a) => a.id)).toEqual(["a1"]);
    expect(canSwitch).toBe(false);
  });

  test("an unreachable local registration is dropped", () => {
    seed([
      platform("a1"),
      platform("lo1", {
        isLocal: true,
        isPlatformHosted: false,
        cloud: undefined,
        ingressUrl: null,
      }),
    ]);

    expect(run().assistants.map((a) => a.id)).toEqual(["a1"]);
  });

  test("without a platform session only paired entries survive", () => {
    hasPlatformSession = false;
    seed([
      platform("a1"),
      platform("pr1", {
        isPaired: true,
        isPlatformHosted: false,
        cloud: "paired",
      }),
    ]);

    const { assistants, canSwitch } = run();
    expect(assistants.map((a) => a.id)).toEqual(["pr1"]);
    expect(canSwitch).toBe(false);
  });

  test("local entries count only on a local client, with no org required", () => {
    hasPlatformSession = false;
    organizationId = null;
    const locals = [
      platform("lo1", {
        isLocal: true,
        isPlatformHosted: false,
        cloud: "local",
      }),
      platform("lo2", {
        isLocal: true,
        isPlatformHosted: false,
        cloud: "local",
      }),
    ];
    seed(locals);

    expect(run().canSwitch).toBe(false);

    localClient = true;
    const { assistants, canSwitch } = run();
    expect(assistants.map((a) => a.id)).toEqual(["lo1", "lo2"]);
    expect(canSwitch).toBe(true);
  });
});
