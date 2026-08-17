import { expect, mock, test } from "bun:test";

const runHookMock = mock(async () => ({}));

mock.module("../plugins/pipeline.js", () => ({
  runHook: runHookMock,
}));

const { HOOKS } = await import("../plugin-api/constants.js");
const { notifyVoiceFrontDoorSettled } = await import("./voice-plugin-hooks.js");

test("voice front-door settlement dispatches through the generic hook pipeline", async () => {
  notifyVoiceFrontDoorSettled("conv-voice", "answer");
  await Promise.resolve();

  expect(runHookMock).toHaveBeenCalledWith(HOOKS.VOICE_FRONT_DOOR_SETTLED, {
    conversationId: "conv-voice",
    outcome: "answer",
  });
});
