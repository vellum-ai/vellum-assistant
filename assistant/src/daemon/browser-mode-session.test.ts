import { afterEach, describe, expect, test } from "bun:test";

import { setOverridesForTesting } from "../__tests__/feature-flag-test-helpers.js";
import type { ModeSession } from "../api/mode-session.js";
import { isSessionGroupsEnabled } from "../config/session-groups-gate.js";
import { BrowserModeSessionProducer } from "./browser-mode-session.js";
import type {
  ModeSessionSourceHandle,
  ModeSessionTerminalDisposition,
} from "./conversation-mode-session.js";

function createCoordinator() {
  let owner: ModeSession | undefined;
  let activation = 0;
  const activated: ModeSessionSourceHandle[] = [];
  const retired: Array<{
    handle: ModeSessionSourceHandle;
    disposition?: ModeSessionTerminalDisposition;
  }> = [];
  const activity: Array<{ turnId: string; at: number }> = [];

  const coordinator = {
    activateSource(input: {
      sourceId: string;
      generation: number;
      mode: "browser";
      sourceStartedAt: number;
    }): ModeSessionSourceHandle {
      activation += 1;
      const handle = {
        sourceId: input.sourceId,
        generation: input.generation,
        activation,
        id: `browser-${activation}`,
        mode: input.mode,
      } as const;
      activated.push(handle);
      return handle;
    },
    claimTurn(
      _turnId: string,
      handle: ModeSessionSourceHandle,
      _at: number,
    ): ModeSession {
      owner ??= { id: handle.id, mode: handle.mode };
      return owner;
    },
    getTurnOwner: () => owner,
    recordActivity: (turnId: string, at: number) => {
      activity.push({ turnId, at });
      return true;
    },
    retireSource: (
      handle: ModeSessionSourceHandle,
      disposition?: ModeSessionTerminalDisposition,
    ) => {
      retired.push({ handle, disposition });
      return true;
    },
  };

  return {
    coordinator,
    activated,
    retired,
    activity,
    clearOwner: () => {
      owner = undefined;
    },
    setOwner: (next: ModeSession) => {
      owner = next;
    },
  };
}

describe("BrowserModeSessionProducer", () => {
  afterEach(() => {
    setOverridesForTesting({});
  });

  test.each([false, true])(
    "retires failed admission while preserving a partial turn owner (%s)",
    (partial) => {
      const state = createCoordinator();
      const claim = state.coordinator.claimTurn;
      state.coordinator.claimTurn = (...args) => {
        if (partial) {
          claim(...args);
        }
        throw new Error("tracking unavailable");
      };
      const producer = new BrowserModeSessionProducer(state.coordinator);
      expect(() =>
        producer.beginOperation({
          turnId: "turn-123",
          lifecycle: "action",
          at: 100,
        }),
      ).toThrow("tracking unavailable");
      expect(state.retired).toHaveLength(1);
      expect(state.retired[0]?.disposition).toMatchObject({
        status: "interrupted",
        endReason: "tracking_failed",
      });
      if (partial) {
        expect(state.coordinator.getTurnOwner()).toBeDefined();
      } else {
        expect(state.coordinator.getTurnOwner()).toBeUndefined();
      }
    },
  );

  test("admits new tracking only while the shared feature flag is enabled", () => {
    const state = createCoordinator();
    const producer = new BrowserModeSessionProducer(
      state.coordinator,
      1,
      isSessionGroupsEnabled,
    );

    setOverridesForTesting({});
    expect(isSessionGroupsEnabled()).toBe(false);
    expect(
      producer.beginOperation({
        turnId: "turn-disabled",
        lifecycle: "action",
        at: 100,
      }),
    ).toBeUndefined();
    expect(state.activated).toEqual([]);

    setOverridesForTesting({ "session-groups": true });
    const admitted = producer.beginOperation({
      turnId: "turn-enabled",
      lifecycle: "action",
      at: 110,
    });
    expect(admitted?.owner).toEqual({ id: "browser-1", mode: "browser" });

    setOverridesForTesting({ "session-groups": false });
    state.clearOwner();
    const close = producer.beginOperation({
      turnId: "turn-close",
      lifecycle: "terminal",
      at: 120,
    });
    expect(close?.owner).toEqual({ id: "browser-1", mode: "browser" });
    expect(
      producer.finishOperation(close, {
        at: 130,
        isError: false,
        cancelled: false,
        terminalReason: "browser_closed",
      }),
    ).toBe(true);
    expect(state.retired).toHaveLength(1);
  });

  test("claims the first action and records repeated successful activity", () => {
    const state = createCoordinator();
    const producer = new BrowserModeSessionProducer(state.coordinator);

    const first = producer.beginOperation({
      turnId: "turn-1",
      lifecycle: "action",
      at: 100,
    });
    expect(first?.owner).toEqual({ id: "browser-1", mode: "browser" });
    expect(state.activated).toHaveLength(1);
    expect(
      producer.finishOperation(first, {
        at: 120,
        isError: false,
        cancelled: false,
      }),
    ).toBe(true);
    expect(state.activity).toEqual([{ turnId: "turn-1", at: 120 }]);

    const repeated = producer.beginOperation({
      turnId: "turn-1",
      lifecycle: "action",
      at: 130,
    });
    expect(repeated?.owner.id).toBe("browser-1");
    expect(state.activated).toHaveLength(1);
  });

  test("status and a terminal operation without an active run are inert", () => {
    const state = createCoordinator();
    const producer = new BrowserModeSessionProducer(state.coordinator);

    expect(
      producer.beginOperation({
        turnId: "turn-1",
        lifecycle: "status",
        at: 100,
      }),
    ).toBeUndefined();
    expect(
      producer.beginOperation({
        turnId: "turn-1",
        lifecycle: "terminal",
        at: 110,
      }),
    ).toBeUndefined();
    expect(state.activated).toEqual([]);
  });

  test("keeps an existing non-browser owner without activating a nested run", () => {
    const state = createCoordinator();
    state.setOwner({ id: "live-1", mode: "live_vision" });
    const producer = new BrowserModeSessionProducer(state.coordinator);

    const token = producer.beginOperation({
      turnId: "turn-1",
      lifecycle: "action",
      at: 100,
    });
    expect(token).toMatchObject({ owner: { id: "live-1" } });
    expect(token?.handle).toBeUndefined();
    expect(state.activated).toEqual([]);
    expect(
      producer.finishOperation(token, {
        at: 120,
        isError: false,
        cancelled: false,
      }),
    ).toBe(true);
    expect(state.activity).toEqual([{ turnId: "turn-1", at: 120 }]);
  });

  test("successful close retires the active run with a completed disposition", () => {
    const state = createCoordinator();
    const producer = new BrowserModeSessionProducer(state.coordinator);
    producer.beginOperation({
      turnId: "turn-1",
      lifecycle: "action",
      at: 100,
    });
    state.clearOwner();

    const close = producer.beginOperation({
      turnId: "turn-close",
      lifecycle: "terminal",
      at: 200,
    });
    expect(close?.owner.id).toBe("browser-1");
    expect(
      producer.finishOperation(close, {
        at: 220,
        isError: false,
        cancelled: false,
        terminalReason: "browser_closed",
      }),
    ).toBe(true);
    expect(state.retired).toEqual([
      {
        handle: expect.objectContaining({ id: "browser-1", activation: 1 }),
        disposition: {
          status: "completed",
          endReason: "browser_closed",
        },
      },
    ]);
  });

  test("a foreign-owned terminal operation retires only the captured browser run", () => {
    const state = createCoordinator();
    const producer = new BrowserModeSessionProducer(state.coordinator);
    producer.beginOperation({
      turnId: "turn-browser",
      lifecycle: "action",
      at: 100,
    });
    state.setOwner({ id: "live-1", mode: "live_vision" });

    const close = producer.beginOperation({
      turnId: "turn-live",
      lifecycle: "terminal",
      at: 200,
    });
    expect(close).toMatchObject({
      owner: { id: "live-1", mode: "live_vision" },
      handle: { id: "browser-1", activation: 1 },
    });
    expect(
      producer.finishOperation(close, {
        at: 220,
        isError: false,
        cancelled: false,
        terminalReason: "browser_detached",
      }),
    ).toBe(true);
    expect(state.retired.at(-1)).toEqual({
      handle: expect.objectContaining({ id: "browser-1", activation: 1 }),
      disposition: {
        status: "completed",
        endReason: "browser_detached",
      },
    });

    state.clearOwner();
    producer.beginOperation({
      turnId: "turn-browser-2",
      lifecycle: "action",
      at: 300,
    });
    expect(
      producer.finishOperation(close, {
        at: 320,
        isError: true,
        cancelled: false,
      }),
    ).toBe(false);
    expect(state.retired).toHaveLength(1);
  });

  test("a failed close keeps the session active until a successful retry", () => {
    const state = createCoordinator();
    const producer = new BrowserModeSessionProducer(state.coordinator);
    const action = producer.beginOperation({
      turnId: "turn-1",
      lifecycle: "action",
      at: 100,
    });
    const close = producer.beginOperation({
      turnId: "turn-1",
      lifecycle: "terminal",
      at: 110,
    });
    expect(
      producer.finishOperation(close, {
        at: 120,
        isError: true,
        cancelled: false,
      }),
    ).toBe(true);
    expect(state.retired).toHaveLength(0);
    expect(state.activity).toEqual([{ turnId: "turn-1", at: 120 }]);

    const retry = producer.beginOperation({
      turnId: "turn-1",
      lifecycle: "terminal",
      at: 130,
    });
    expect(retry?.handle).toEqual(action?.handle);
    producer.finishOperation(retry, {
      at: 140,
      isError: false,
      cancelled: false,
    });
    expect(state.retired[0]?.disposition).toEqual({
      status: "completed",
      endReason: "browser_closed",
    });
  });

  test("cancellation retires the exact run while accepted output remains on its captured turn", () => {
    const state = createCoordinator();
    const producer = new BrowserModeSessionProducer(state.coordinator);
    const stale = producer.beginOperation({
      turnId: "turn-1",
      lifecycle: "action",
      at: 100,
    });
    expect(
      producer.finishOperation(stale, {
        at: 120,
        isError: true,
        cancelled: true,
      }),
    ).toBe(true);
    expect(state.retired[0]?.disposition).toEqual({
      status: "interrupted",
      endReason: "browser_operation_cancelled",
    });

    state.clearOwner();
    const current = producer.beginOperation({
      turnId: "turn-2",
      lifecycle: "action",
      at: 200,
    });
    expect(current?.handle?.activation).toBe(2);
    expect(
      producer.finishOperation(stale, {
        at: 210,
        isError: true,
        cancelled: true,
      }),
    ).toBe(false);
    expect(
      producer.finishOperation(stale, {
        at: 220,
        isError: false,
        cancelled: false,
      }),
    ).toBe(true);
    expect(state.activity).toEqual([{ turnId: "turn-1", at: 220 }]);
    expect(state.retired).toHaveLength(1);
  });
});
