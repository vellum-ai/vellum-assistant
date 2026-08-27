import { expect, mock, test } from "bun:test";

import { createLocalModeBridge } from "./local-mode-bridge";

test("forwards the complete local-mode namespace through IPC", async () => {
  const invoke = mock(() => Promise.resolve({ ok: true }));
  const bridge = createLocalModeBridge({ invoke } as never);

  await bridge.hatch("vellum", "remote");
  await bridge.readLockfile();
  await bridge.saveLockfileAssistant(
    { assistantId: "assistant-1" },
    "assistant-1",
  );
  await bridge.replacePlatformAssistants([], "org-1");
  await bridge.retire("assistant-1");
  await bridge.sleep("assistant-1");
  await bridge.wake("assistant-1", { repairGuardian: true });
  await bridge.upgrade("assistant-1", { latest: true });
  await bridge.status("assistant-1");
  await bridge.unpair("assistant-1");
  await bridge.pairingStart("https://gw.example.com");
  await bridge.pairingPoll("handle-1", "Assistant 1");
  await bridge.pairingCancel("handle-1");
  await bridge.guardianToken("assistant-1");
  await bridge.listDevices("assistant-1");
  await bridge.revokeDevice("assistant-1", "hash-1");

  expect(invoke).toHaveBeenCalledTimes(16);
  expect(invoke).toHaveBeenCalledWith("vellum:localMode:wake", "assistant-1", {
    repairGuardian: true,
  });
  expect(invoke).toHaveBeenCalledWith(
    "vellum:localMode:revokeDevice",
    "assistant-1",
    "hash-1",
  );
  expect(invoke).toHaveBeenCalledWith(
    "vellum:localMode:pairingPoll",
    "handle-1",
    "Assistant 1",
  );
});
