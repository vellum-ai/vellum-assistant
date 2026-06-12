import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { z } from "zod";

// Capture the channel + schema + handler that `installVoiceStateIpc`
// registers, without dragging in the real `ipcMain` / sender-origin guard
// (covered by `ipc.test.ts`). The captured schema is exercised directly so we
// assert the payload contract the renderer must satisfy.
type OnRegistration = {
  channel: string;
  schema: z.ZodType<unknown[]>;
  fn: (args: unknown[]) => void;
};
const registrations: OnRegistration[] = [];
const onMock = mock(
  (channel: string, schema: z.ZodType<unknown[]>, fn: (args: unknown[]) => void) => {
    registrations.push({ channel, schema, fn });
  },
);
mock.module("./ipc", () => ({ on: onMock }));

const {
  VOICE_MODE_STATES,
  getVoiceState,
  installVoiceStateIpc,
  onVoiceStateChange,
  setVoiceState,
  voiceMenuTitle,
  __resetForTesting,
} = await import("./voice-state");

beforeEach(() => {
  __resetForTesting();
  registrations.length = 0;
  onMock.mockClear();
});

describe("voiceMenuTitle", () => {
  test("produces a line for every active state and null when off", () => {
    expect(voiceMenuTitle("off")).toBeNull();
    expect(voiceMenuTitle("idle")).toBe("Assistant — voice mode ready");
    expect(voiceMenuTitle("listening")).toBe("Assistant is listening…");
    expect(voiceMenuTitle("processing")).toBe("Assistant is thinking…");
    expect(voiceMenuTitle("speaking")).toBe("Assistant is speaking…");
    expect(voiceMenuTitle("listening", "Vellum")).toBe("Vellum is listening…");
  });
});

describe("voice state machine", () => {
  test("starts off, transitions on set, and notifies listeners once per change", () => {
    expect(getVoiceState()).toBe("off");

    const seen: string[] = [];
    const unsubscribe = onVoiceStateChange((state) => seen.push(state));

    setVoiceState("listening");
    setVoiceState("listening"); // duplicate republish must not re-notify
    setVoiceState("speaking");

    expect(getVoiceState()).toBe("speaking");
    expect(seen).toEqual(["listening", "speaking"]);

    unsubscribe();
    setVoiceState("off");
    expect(seen).toEqual(["listening", "speaking"]);
  });
});

describe("installVoiceStateIpc", () => {
  test("registers vellum:voice:state once and applies valid payloads", () => {
    installVoiceStateIpc();
    installVoiceStateIpc(); // idempotent

    expect(registrations).toHaveLength(1);
    const registration = registrations[0]!;
    expect(registration.channel).toBe("vellum:voice:state");

    for (const state of VOICE_MODE_STATES) {
      expect(registration.schema.safeParse([state]).success).toBe(true);
    }
    expect(registration.schema.safeParse(["bogus"]).success).toBe(false);
    expect(registration.schema.safeParse([]).success).toBe(false);

    registration.fn(["processing"]);
    expect(getVoiceState()).toBe("processing");
  });
});
