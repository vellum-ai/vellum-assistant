import { afterEach, describe, expect, test } from "bun:test";

import { setOverridesForTesting } from "../__tests__/feature-flag-test-helpers.js";
import type { ModeSession } from "../api/mode-session.js";
import { isSessionGroupsEnabled } from "../config/session-groups-gate.js";
import { ComputerUseModeSessionProducer } from "./computer-use-mode-session.js";
import type { ModeSessionSourceHandle } from "./conversation-mode-session.js";

function createCoordinator() {
  let owner: ModeSession | undefined;
  let activation = 0;
  const activated: Array<{
    sourceId: string;
    generation: number;
    mode: "computer_use";
    sourceStartedAt: number;
  }> = [];
  const retired: ModeSessionSourceHandle[] = [];
  const activity: Array<{ turnId: string; at: number }> = [];
  const draining: string[] = [];

  const coordinator = {
    activateSource(input: {
      sourceId: string;
      generation: number;
      mode: "computer_use";
      sourceStartedAt: number;
    }): ModeSessionSourceHandle {
      activated.push(input);
      activation += 1;
      return {
        sourceId: input.sourceId,
        generation: input.generation,
        activation,
        id: `session-${activation}`,
        mode: input.mode,
      };
    },
    claimTurn(
      _turnId: string,
      handle: ModeSessionSourceHandle,
      _at: number,
    ): ModeSession {
      owner = { id: handle.id, mode: handle.mode };
      return owner;
    },
    getTurnOwner: () => owner,
    recordActivity: (turnId: string, at: number) => {
      activity.push({ turnId, at });
      return true;
    },
    retireSource: (handle: ModeSessionSourceHandle) => {
      retired.push(handle);
      return true;
    },
    beginDraining: (turnId: string) => {
      draining.push(turnId);
      return true;
    },
  };

  return {
    coordinator,
    activated,
    retired,
    activity,
    draining,
    clearOwner: () => {
      owner = undefined;
    },
    setOwner: (next: ModeSession) => {
      owner = next;
    },
  };
}

describe("ComputerUseModeSessionProducer", () => {
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
      const producer = new ComputerUseModeSessionProducer(state.coordinator);
      expect(() =>
        producer.recordAction({
          turnId: "turn-123",
          source: { sourceId: "computer", generation: 1 },
          at: 100,
        }),
      ).toThrow("tracking unavailable");
      expect(state.retired).toHaveLength(1);
      expect(state.retired[0]?.mode).toBe("computer_use");
      if (partial) {
        expect(state.coordinator.getTurnOwner()).toBeDefined();
      } else {
        expect(state.coordinator.getTurnOwner()).toBeUndefined();
      }
    },
  );

  test("admits new tracking only while the shared feature flag is enabled", () => {
    const state = createCoordinator();
    const producer = new ComputerUseModeSessionProducer(
      state.coordinator,
      isSessionGroupsEnabled,
    );
    const source = { sourceId: "proxy-123", generation: 2 };

    setOverridesForTesting({ "session-groups": false });
    expect(
      producer.recordAction({ turnId: "turn-disabled", source, at: 100 }),
    ).toBeUndefined();
    expect(state.activated).toEqual([]);

    setOverridesForTesting({ "session-groups": true });
    expect(
      producer.recordAction({ turnId: "turn-enabled", source, at: 110 }),
    ).toEqual({ id: "session-1", mode: "computer_use" });

    setOverridesForTesting({ "session-groups": false });
    expect(producer.endTask({ turnId: "turn-enabled", source })).toBe(true);
    expect(state.retired).toHaveLength(1);
    expect(state.draining).toEqual(["turn-enabled"]);
  });

  test("activates on the first action and records later action activity", () => {
    const state = createCoordinator();
    const producer = new ComputerUseModeSessionProducer(state.coordinator);
    const source = { sourceId: "proxy-123", generation: 2 };

    expect(
      producer.recordAction({ turnId: "turn-123", source, at: 100 }),
    ).toEqual({ id: "session-1", mode: "computer_use" });
    expect(state.activated).toEqual([
      expect.objectContaining({ ...source, sourceStartedAt: 100 }),
    ]);

    producer.recordAction({ turnId: "turn-123", source, at: 120 });
    expect(state.activated).toHaveLength(1);
    expect(state.activity).toEqual([{ turnId: "turn-123", at: 120 }]);
  });

  test("keeps an existing mode owner without activating a secondary run", () => {
    const state = createCoordinator();
    state.setOwner({ id: "live-123", mode: "live_vision" });
    const producer = new ComputerUseModeSessionProducer(state.coordinator);

    expect(
      producer.recordAction({
        turnId: "turn-123",
        source: { sourceId: "proxy-123", generation: 0 },
        at: 100,
      }),
    ).toEqual({ id: "live-123", mode: "live_vision" });
    expect(state.activated).toEqual([]);
    expect(state.activity).toEqual([{ turnId: "turn-123", at: 100 }]);
  });

  test("terminal end retires its exact handle and begins final reply drain", () => {
    const state = createCoordinator();
    const producer = new ComputerUseModeSessionProducer(state.coordinator);
    const source = { sourceId: "proxy-123", generation: 3 };
    producer.recordAction({ turnId: "turn-123", source, at: 100 });

    expect(producer.endTask({ turnId: "turn-123", source })).toBe(true);
    expect(state.retired).toEqual([
      expect.objectContaining({
        sourceId: "proxy-123",
        generation: 3,
        activation: 1,
        id: "session-1",
      }),
    ]);
    expect(state.draining).toEqual(["turn-123"]);
  });

  test("stale terminal callbacks cannot retire a replacement activation", () => {
    const state = createCoordinator();
    const producer = new ComputerUseModeSessionProducer(state.coordinator);
    const oldSource = { sourceId: "proxy-123", generation: 3 };
    producer.recordAction({ turnId: "turn-old", source: oldSource, at: 100 });
    state.clearOwner();

    const nextSource = { sourceId: "proxy-123", generation: 4 };
    producer.recordAction({ turnId: "turn-new", source: nextSource, at: 200 });

    expect(producer.endTask({ turnId: "turn-old", source: oldSource })).toBe(
      false,
    );
    expect(state.retired).toEqual([]);
    expect(producer.endTask({ turnId: "turn-new", source: nextSource })).toBe(
      true,
    );
    expect(state.retired[0]).toMatchObject({
      generation: 4,
      activation: 2,
      id: "session-2",
    });
  });
});
