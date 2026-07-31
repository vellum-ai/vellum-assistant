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

// The surface requires the two-level channel contract — the runtime collapse
// of stored `medium`/`high` cells, the room default for cell-less rooms, and
// the sensitive-tool floor lift, which ships in 0.11.0. A 0.10.8–0.10.12
// assistant serves the channel-permission-overrides routes but honors raw
// thresholds, so the two-level picker would display "Conservative" for a
// cell that backend treats as its stored value. `false` = render the
// read-only channel list without access controls. Exhaustive semver
// semantics (pre-release handling, unparseable versions) live in
// `utils.test.ts`.
describe("useSupportsChannelAccessControls", () => {
  test("false when version is unknown", () => {
    setVersion(null);
    const { result } = renderHook(() => useSupportsChannelAccessControls());
    expect(result.current).toBe(false);
  });

  test("false on 0.10.12 — the routes exist but the two-level contract does not (guards the off-by-one)", () => {
    setVersion("0.10.12");
    const { result } = renderHook(() => useSupportsChannelAccessControls());
    expect(result.current).toBe(false);
  });

  test("true on 0.11.0+, the first release carrying the two-level contract", () => {
    setVersion("0.11.0");
    const { result } = renderHook(() => useSupportsChannelAccessControls());
    expect(result.current).toBe(true);
  });

  test("true for RC builds of the cutover release", () => {
    setVersion("0.11.0-rc.1");
    const { result } = renderHook(() => useSupportsChannelAccessControls());
    expect(result.current).toBe(true);
  });
});
