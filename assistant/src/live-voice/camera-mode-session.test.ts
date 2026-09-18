import { describe, expect, test } from "bun:test";

import type { ModeSessionMode } from "../api/mode-session.js";
import type {
  ModeSessionSourceHandle,
  ModeSessionTerminalDisposition,
} from "../daemon/conversation-mode-session.js";
import { CameraModeSessionProducer } from "./camera-mode-session.js";

function createCoordinator() {
  let activation = 0;
  const owners = new Map<string, ModeSessionSourceHandle>();
  const retired: Array<{
    handle: ModeSessionSourceHandle;
    disposition?: ModeSessionTerminalDisposition;
  }> = [];
  const rows: Array<{ turnId: string; messageId: string; at: number }> = [];
  const releases: string[] = [];

  const coordinator = {
    activateSource(input: {
      sourceId: string;
      generation: number;
      mode: ModeSessionMode;
    }): ModeSessionSourceHandle {
      activation += 1;
      return {
        sourceId: input.sourceId,
        generation: input.generation,
        activation,
        id: `camera-${activation}`,
        mode: input.mode,
      };
    },
    claimTurn(
      turnId: string,
      handle: ModeSessionSourceHandle,
    ): ModeSessionSourceHandle {
      owners.set(turnId, handle);
      return handle;
    },
    recordActivity: () => true,
    retireSource(
      handle: ModeSessionSourceHandle,
      disposition?: ModeSessionTerminalDisposition,
    ): boolean {
      retired.push({ handle, disposition });
      return true;
    },
    trackPersistedRow(turnId: string, messageId: string, at: number): void {
      rows.push({ turnId, messageId, at });
    },
    releaseTurn(turnId: string): void {
      releases.push(turnId);
      owners.delete(turnId);
    },
  };
  return { coordinator, owners, retired, rows, releases };
}

describe("CameraModeSessionProducer", () => {
  test("starts before a frame and exposes the same owner to voice turns", () => {
    const state = createCoordinator();
    const producer = new CameraModeSessionProducer(
      state.coordinator,
      "voice-1",
    );

    const handle = producer.start(1, "live", 100);
    expect(handle).toMatchObject({
      generation: 1,
      mode: "live_vision",
      sourceId: "live-voice-camera:voice-1",
    });
    expect(producer.captureTurn()).toEqual(handle);
    expect(producer.start(1, "live", 110)).toEqual(handle);
  });

  test("rolls back a partially claimed start and allows the epoch to retry", () => {
    const state = createCoordinator();
    const producer = new CameraModeSessionProducer(
      state.coordinator,
      "voice-1",
    );
    const claimTurn = state.coordinator.claimTurn.bind(state.coordinator);
    let shouldThrow = true;
    state.coordinator.claimTurn = (turnId, handle) => {
      const owner = claimTurn(turnId, handle);
      if (shouldThrow) {
        shouldThrow = false;
        throw new Error("session tracking unavailable");
      }
      return owner;
    };

    expect(() => producer.start(1, "ambient", 100)).toThrow(
      "session tracking unavailable",
    );
    expect(producer.captureTurn()).toBeUndefined();
    expect(state.owners.size).toBe(0);
    expect(state.retired).toEqual([
      expect.objectContaining({
        disposition: {
          status: "interrupted",
          endReason: "camera_start_refused",
        },
      }),
    ]);
    expect(state.releases).toHaveLength(1);

    expect(producer.start(1, "ambient", 110)).toMatchObject({
      generation: 1,
      activation: 2,
      mode: "ambient",
    });
  });

  test("releases a partial claim even when source retirement throws", () => {
    const state = createCoordinator();
    const producer = new CameraModeSessionProducer(
      state.coordinator,
      "voice-1",
    );
    const claimTurn = state.coordinator.claimTurn.bind(state.coordinator);
    state.coordinator.claimTurn = (turnId, handle) => {
      claimTurn(turnId, handle);
      throw new Error("session tracking unavailable");
    };
    state.coordinator.retireSource = () => {
      throw new Error("source retirement unavailable");
    };

    expect(() => producer.start(1, "live", 100)).toThrow(AggregateError);
    expect(producer.captureTurn()).toBeUndefined();
    expect(state.owners.size).toBe(0);
    expect(state.releases).toHaveLength(1);
  });

  test("rolls back a refused synthetic owner", () => {
    const state = createCoordinator();
    const producer = new CameraModeSessionProducer(
      state.coordinator,
      "voice-1",
    );
    const claimTurn = state.coordinator.claimTurn.bind(state.coordinator);
    state.coordinator.claimTurn = (turnId, handle) => {
      claimTurn(turnId, handle);
      return { ...handle, id: "another-session" };
    };

    expect(producer.start(1, "live", 100)).toBeUndefined();
    expect(producer.captureTurn()).toBeUndefined();
    expect(state.owners.size).toBe(0);
    expect(state.retired).toHaveLength(1);
    expect(state.releases).toHaveLength(1);
  });

  test("holds terminal publication until accepted keeps settle", () => {
    const state = createCoordinator();
    const producer = new CameraModeSessionProducer(
      state.coordinator,
      "voice-1",
    );
    producer.start(1, "ambient", 100);
    const frame = producer.beginFrame(1, "ambient");

    expect(producer.end(1)).toBe(true);
    expect(state.releases).toEqual([]);
    producer.finishFrame(frame, { messageId: "frame-1", at: 140 });

    expect(state.rows).toEqual([
      expect.objectContaining({ messageId: "frame-1", at: 140 }),
    ]);
    expect(state.releases).toHaveLength(1);
    expect(state.retired[0]?.disposition).toEqual({
      status: "completed",
      endReason: "camera_stopped",
    });
  });

  test("settles each accepted keep exactly once", () => {
    const state = createCoordinator();
    const producer = new CameraModeSessionProducer(
      state.coordinator,
      "voice-1",
    );
    producer.start(1, "ambient", 100);
    const frame = producer.beginFrame(1, "ambient");
    producer.end(1);

    producer.finishFrame(frame, { messageId: "frame-1", at: 140 });
    producer.finishFrame(frame, { messageId: "frame-1", at: 140 });

    expect(state.rows).toHaveLength(1);
    expect(state.releases).toHaveLength(1);
  });

  test("rejects stale frames and ends without requiring another message", () => {
    const state = createCoordinator();
    const producer = new CameraModeSessionProducer(
      state.coordinator,
      "voice-1",
    );
    producer.start(1, "live", 100);
    producer.end(1);
    producer.start(2, "live", 200);

    expect(producer.start(1, "live", 210)).toBeUndefined();
    expect(producer.beginFrame(1, "live")).toBeUndefined();
    expect(producer.beginFrame(2, "ambient")).toBeUndefined();
    expect(producer.end(1)).toBe(false);
    expect(producer.captureTurn()).toMatchObject({ generation: 2 });
    expect(state.retired).toHaveLength(1);
    expect(state.releases).toHaveLength(1);
  });

  test("retires an unended run as interrupted when a replacement starts", () => {
    const state = createCoordinator();
    const producer = new CameraModeSessionProducer(
      state.coordinator,
      "voice-1",
    );
    producer.start(1, "live", 100);
    producer.start(2, "ambient", 200);

    expect(state.retired[0]?.disposition).toEqual({
      status: "interrupted",
      endReason: "camera_source_replaced",
    });
    expect(producer.captureTurn()).toMatchObject({ mode: "ambient" });
  });

  test("releases the local run when source retirement throws after mutation", () => {
    const state = createCoordinator();
    const producer = new CameraModeSessionProducer(
      state.coordinator,
      "voice-1",
    );
    producer.start(1, "live", 100);
    const retireSource = state.coordinator.retireSource.bind(state.coordinator);
    state.coordinator.retireSource = (handle, disposition) => {
      retireSource(handle, disposition);
      throw new Error("source retirement unavailable");
    };

    expect(() => producer.end(1)).toThrow("source retirement unavailable");
    expect(producer.captureTurn()).toBeUndefined();
    expect(state.releases).toHaveLength(1);
    expect(producer.end(1)).toBe(false);
  });

  test("releases the synthetic turn when its source is already stale", () => {
    const state = createCoordinator();
    const producer = new CameraModeSessionProducer(
      state.coordinator,
      "voice-1",
    );
    producer.start(1, "live", 100);
    state.coordinator.retireSource = () => false;

    expect(producer.end(1)).toBe(false);
    expect(producer.captureTurn()).toBeUndefined();
    expect(state.releases).toHaveLength(1);
  });
});
