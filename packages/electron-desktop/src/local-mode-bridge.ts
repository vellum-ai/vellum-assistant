import type { IpcRenderer } from "electron";

import type { VellumBridge } from "@vellumai/ipc-contract";

type RendererIpc = Pick<IpcRenderer, "invoke">;

export const createLocalModeBridge = (
  ipc: RendererIpc,
): VellumBridge["localMode"] => ({
  connectImport: (bundle, name) =>
    ipc.invoke("vellum:localMode:connectImport", bundle, name),
  guardianToken: (assistantId) =>
    ipc.invoke("vellum:localMode:guardianToken", assistantId),
  hatch: (species, remote) =>
    ipc.invoke("vellum:localMode:hatch", species, remote),
  listDevices: (assistantId) =>
    ipc.invoke("vellum:localMode:listDevices", assistantId),
  readLockfile: () => ipc.invoke("vellum:localMode:readLockfile"),
  renameLockfileAssistant: (assistantId, name) =>
    ipc.invoke("vellum:localMode:renameLockfileAssistant", assistantId, name),
  replacePlatformAssistants: (assistants, organizationId) =>
    ipc.invoke(
      "vellum:localMode:replacePlatformAssistants",
      assistants,
      organizationId,
    ),
  retire: (assistantId) => ipc.invoke("vellum:localMode:retire", assistantId),
  revokeDevice: (assistantId, hashedDeviceId) =>
    ipc.invoke("vellum:localMode:revokeDevice", assistantId, hashedDeviceId),
  saveLockfileAssistant: (assistant, activeAssistant) =>
    ipc.invoke(
      "vellum:localMode:saveLockfileAssistant",
      assistant,
      activeAssistant,
    ),
  sleep: (assistantId) => ipc.invoke("vellum:localMode:sleep", assistantId),
  status: (assistantId) => ipc.invoke("vellum:localMode:status", assistantId),
  unpair: (assistantId) => ipc.invoke("vellum:localMode:unpair", assistantId),
  upgrade: (assistantId, options) =>
    ipc.invoke("vellum:localMode:upgrade", assistantId, options),
  wake: (assistantId, options) =>
    ipc.invoke("vellum:localMode:wake", assistantId, options),
});
