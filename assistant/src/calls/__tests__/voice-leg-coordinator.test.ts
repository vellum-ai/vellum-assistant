import { describe, expect, test } from "bun:test";

import {
  createFrontDoorLegCoordinator,
  type EscalatedLeg,
  escalatedLegFor,
  type FrontDoorLegHost,
  type SpokenEscalationBridge,
} from "../voice-leg-coordinator.js";
import {
  ESCALATION_CONTINUATION_CONTENT,
  FALLBACK_ESCALATION_BRIDGE,
  FALLBACK_ESCALATION_BRIDGE_BY_LANGUAGE,
} from "../voice-triage-escalate.js";

interface Recorded {
  events: string[];
  answers: string[];
  bridges: SpokenEscalationBridge[];
  escalated: EscalatedLeg[];
  holds: number;
  commits: number;
}

function harness(opts?: {
  holdEnabled?: boolean;
  live?: () => boolean;
  language?: string;
  commit?: () => boolean;
  withProgress?: boolean;
  withHold?: boolean;
}) {
  const recorded: Recorded = {
    events: [],
    answers: [],
    bridges: [],
    escalated: [],
    holds: 0,
    commits: 0,
  };
  const host: FrontDoorLegHost = {
    isLive: opts?.live ?? (() => true),
    language: () => opts?.language,
    ...(opts?.withProgress === false
      ? {}
      : {
          progress: {
            clear: () => recorded.events.push("progress.clear"),
            noteFloorHolder: () => recorded.events.push("progress.floor"),
            arm: () => recorded.events.push("progress.arm"),
          },
        }),
    ...(opts?.withHold
      ? {
          onHold: () => {
            recorded.holds += 1;
            recorded.events.push("hold");
          },
        }
      : {}),
    ...(opts?.commit
      ? {
          commit: () => {
            recorded.commits += 1;
            recorded.events.push("commit");
            return opts.commit!();
          },
        }
      : {}),
    onAnswerText: (text) => {
      recorded.answers.push(text);
      recorded.events.push(`answer:${text}`);
    },
    abortLeg: () => recorded.events.push("abort"),
    speakBridge: (bridge) => {
      recorded.bridges.push(bridge);
      recorded.events.push(`speak:${bridge.spokenBridge}`);
    },
    startEscalatedLeg: (leg) => {
      recorded.escalated.push(leg);
      recorded.events.push("start-escalated");
    },
  };
  const coordinator = createFrontDoorLegCoordinator({
    holdEnabled: opts?.holdEnabled ?? false,
    host,
  });
  return { coordinator, recorded };
}

describe("escalatedLegFor", () => {
  test("continues on the escalated leg with the spoken bridge quoted", () => {
    expect(escalatedLegFor("One moment.")).toEqual({
      content: ESCALATION_CONTINUATION_CONTENT,
      routingLeg: "escalated",
      spokenEscalationBridge: "One moment.",
    });
  });
});

describe("createFrontDoorLegCoordinator", () => {
  test("an answer releases the held leading text, then streams", () => {
    const { coordinator, recorded } = harness();
    coordinator.push("[");
    expect(recorded.answers).toEqual([]);
    coordinator.push("END_CALL] Bye");
    coordinator.push(" now.");

    expect(recorded.answers).toEqual(["[END_CALL] Bye", " now."]);
    expect(coordinator.complete()).toBe(false);
    expect(coordinator.handedOff).toBe(false);
    expect(recorded.escalated).toEqual([]);
  });

  test("an escalate verdict hands off in order: pause, abort, speak, floor, start, re-arm", () => {
    const { coordinator, recorded } = harness();
    coordinator.push("[1] Let me check");
    expect(coordinator.handedOff).toBe(false);
    coordinator.push(" that.");

    expect(coordinator.handedOff).toBe(true);
    expect(recorded.events).toEqual([
      "progress.clear",
      "abort",
      "speak:Let me check that.",
      "progress.floor",
      "start-escalated",
      "progress.arm",
    ]);
    expect(recorded.bridges[0]).toEqual({
      spokenBridge: "Let me check that.",
      usesFallback: false,
    });
    expect(recorded.escalated).toEqual([escalatedLegFor("Let me check that.")]);
  });

  test("after the hand-off the leg's stream and completion are ignored", () => {
    const { coordinator, recorded } = harness();
    coordinator.push("[1] One moment.");
    coordinator.push(" Ignored past the cap.");
    expect(coordinator.complete()).toBe(true);

    expect(recorded.answers).toEqual([]);
    expect(recorded.escalated.length).toBe(1);
  });

  test("a leg that stops mid-bridge hands off on completion with the canned bridge", () => {
    const { coordinator, recorded } = harness({ language: "es" });
    coordinator.push("[1]");
    expect(coordinator.handedOff).toBe(false);

    expect(coordinator.complete()).toBe(true);
    expect(recorded.bridges[0]).toEqual({
      spokenBridge: FALLBACK_ESCALATION_BRIDGE_BY_LANGUAGE.es,
      usesFallback: true,
    });
    expect(recorded.escalated[0].spokenEscalationBridge).toBe(
      FALLBACK_ESCALATION_BRIDGE_BY_LANGUAGE.es,
    );
  });

  test("the canned bridge for a language the table lacks is English and says so", () => {
    const { coordinator, recorded } = harness({ language: "ko" });
    coordinator.push("[1]");
    coordinator.complete();

    expect(recorded.bridges[0]).toEqual({
      spokenBridge: FALLBACK_ESCALATION_BRIDGE,
      usesFallback: true,
      language: "en",
    });
  });

  test("a dead turn never hands off", () => {
    let live = true;
    const { coordinator, recorded } = harness({ live: () => live });
    coordinator.push("[1] One");
    live = false;
    coordinator.push(" moment.");
    expect(coordinator.handedOff).toBe(false);
    expect(coordinator.complete()).toBe(false);

    expect(recorded.escalated).toEqual([]);
    expect(recorded.events).toEqual([]);
  });

  test("a hold verdict on a speculative leg discards the leg", () => {
    const { coordinator, recorded } = harness({
      holdEnabled: true,
      withHold: true,
    });
    coordinator.push("[0]");

    expect(recorded.holds).toBe(1);
    expect(recorded.answers).toEqual([]);
    expect(coordinator.handedOff).toBe(false);
  });

  test("a leg that does not teach the hold token reads [0] as an answer", () => {
    const { coordinator, recorded } = harness({ withHold: true });
    coordinator.push("[0] Sure.");

    expect(recorded.holds).toBe(0);
    expect(recorded.answers).toEqual(["[0] Sure."]);
  });

  test("answer and escalate verdicts commit a speculative turn first; a failed commit stops the verdict", () => {
    const committed = harness({ commit: () => true });
    committed.coordinator.push("Hello.");
    expect(committed.recorded.events).toEqual(["commit", "answer:Hello."]);

    const gone = harness({ commit: () => false });
    gone.coordinator.push("[1] One moment.");
    expect(gone.recorded.commits).toBe(1);
    expect(gone.coordinator.handedOff).toBe(false);
    expect(gone.recorded.escalated).toEqual([]);
  });

  test("works without a progress cadence", () => {
    const { coordinator, recorded } = harness({ withProgress: false });
    coordinator.push("[1] One moment.");

    expect(recorded.events).toEqual([
      "abort",
      "speak:One moment.",
      "start-escalated",
    ]);
  });
});
