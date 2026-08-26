import { afterEach, beforeEach, expect, test } from "bun:test";

import {
  __resetRecordingState,
  claimRecording,
  handleRecordingStart,
  isRecordingIdle,
} from "../../daemon/handlers/recording.js";
import { ROUTES } from "./recording-routes.js";

const statusHandler = ROUTES.find(
  (route) => route.operationId === "recordings_status_post",
)!.handler;

beforeEach(() => {
  __resetRecordingState();
});

afterEach(() => {
  __resetRecordingState();
});

test("rejects status callbacks from a stale recording owner", async () => {
  const recordingId = handleRecordingStart("conv-1", undefined)!;
  expect(claimRecording(recordingId, "client-1", { now: 0 })).toBeTrue();
  expect(
    claimRecording(recordingId, "client-2", {
      now: 1,
      isClientConnected: () => false,
    }),
  ).toBeTrue();

  await expect(
    statusHandler({
      body: {
        conversationId: recordingId,
        status: "failed",
        error: "stale owner",
      },
      headers: { "x-vellum-client-id": "client-1" },
    } as never),
  ).rejects.toThrow("another client");

  expect(isRecordingIdle()).toBeFalse();
});
