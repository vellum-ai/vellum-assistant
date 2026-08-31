/**
 * @vellumai/ipc-contract — Single source of truth for the Electron bridge
 * IPC surface: payload types, Zod validation schemas, the VellumBridge
 * interface, and channel name constants.
 *
 * This is a package entry point, not an app-code barrel file. The
 * "no barrel files" convention in CONVENTIONS.md targets intra-app
 * subdirectory index files that create circular deps; package entry
 * points are the standard Node/Bun resolution mechanism and are
 * explicitly allowed.
 */
export * from "./types";
export * from "./accelerators";
export * from "./accelerator-keys";
export * from "./schemas";
export {
  type ElectronHostOS,
  type LocalListDevicesResult,
  type LocalPairedDeviceRecord,
  type LocalPairingFailure,
  type LocalPairingFailureReason,
  type LocalPairingPollResult,
  type LocalPairingStartResult,
  type LocalReadAssistantAvatarResult,
  type LocalRevokeDeviceResult,
  type LocalUpgradeOptions,
  type LocalWakeOptions,
  type VellumBridge,
  VELLUM_BRIDGE_KEYS,
} from "./bridge";
export * from "./channels";
