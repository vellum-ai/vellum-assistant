import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { renderHook } from "@testing-library/react";

import { useSupportsChannelAccessControls } from "@/lib/backwards-compat/channel-access-controls";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

function setVersion(version: string | null) {
  useAssistantIdentityStore.getState().setIdentity("test-asst", version);
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

// The channel-permission-overrides list/set/delete routes first shipped in
// 0.10.8 (v0.10.7's gateway index has zero occurrences of the handler). A
// 0.10.7 assistant that passed this gate would render the pickers and then 404
// the route that isn't there — the dead disabled state. `false` = render the
// read-only channel list without access controls. Exhaustive semver semantics
// (pre-release handling, unparseable versions) live in `utils.test.ts`.
describe("useSupportsChannelAccessControls", () => {
  test("false when version is unknown", () => {
    setVersion(null);
    const { result } = renderHook(() => useSupportsChannelAccessControls());
    expect(result.current).toBe(false);
  });

  test("false on 0.10.7 — the route isn't there yet (guards the off-by-one)", () => {
    setVersion("0.10.7");
    const { result } = renderHook(() => useSupportsChannelAccessControls());
    expect(result.current).toBe(false);
  });

  test("true on 0.10.8+, the first release carrying the routes", () => {
    setVersion("0.10.8");
    const { result } = renderHook(() => useSupportsChannelAccessControls());
    expect(result.current).toBe(true);
  });

  test("true for RC builds of the cutover patch", () => {
    setVersion("0.10.8-rc.1");
    const { result } = renderHook(() => useSupportsChannelAccessControls());
    expect(result.current).toBe(true);
  });
});
