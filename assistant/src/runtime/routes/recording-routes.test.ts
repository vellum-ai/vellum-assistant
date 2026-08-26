import { afterEach, beforeEach, expect, test } from "bun:test";

import {
  __resetRecordingState,
  claimRecording,
  handleRecordingStart,
  isRecordingIdle,
  ownsRecordingClaim,
} from "../../daemon/handlers/recording.js";
import { assistantEventHub } from "../assistant-event-hub.js";
import { ROUTES } from "./recording-routes.js";

const claimHandler = ROUTES.find(
  (route) => route.operationId === "recordings_claim",
)!.handler;
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

test("accepts a legacy started status when no client claimed first", async () => {
  const recordingId = handleRecordingStart("conv-1", undefined)!;

  await statusHandler({
    body: { conversationId: recordingId, status: "started" },
    headers: { "x-vellum-client-id": "legacy-client" },
  } as never);

  expect(ownsRecordingClaim(recordingId, "legacy-client")).toBeTrue();
});

test("keeps a desktop claim while its hidden renderer is disconnected", async () => {
  const ownerHost = assistantEventHub.subscribe({
    type: "client",
    clientId: "desktop-host-1",
    interfaceId: "windows",
    capabilities: [],
    actorPrincipalId: "actor-1",
    callback: () => undefined,
  });
  const contenderHost = assistantEventHub.subscribe({
    type: "client",
    clientId: "desktop-host-2",
    interfaceId: "windows",
    capabilities: [],
    actorPrincipalId: "actor-1",
    callback: () => undefined,
  });
  try {
    const recordingId = handleRecordingStart("conv-hidden", undefined)!;
    const ownerResult = (await claimHandler({
      body: { recordingId },
      headers: {
        "x-vellum-client-id": "hidden-renderer-1",
        "vellum-device-id": "desktop-host-1",
        "x-vellum-actor-principal-id": "actor-1",
      },
    } as never)) as { outcome: string };
    const contenderResult = (await claimHandler({
      body: { recordingId },
      headers: {
        "x-vellum-client-id": "renderer-2",
        "vellum-device-id": "desktop-host-2",
        "x-vellum-actor-principal-id": "actor-1",
      },
    } as never)) as { outcome: string };

    expect(ownerResult.outcome).toBe("claimed");
    expect(contenderResult.outcome).toBe("occupied");
    expect(ownsRecordingClaim(recordingId, "desktop-host-1")).toBeTrue();
  } finally {
    ownerHost.dispose();
    contenderHost.dispose();
  }
});
