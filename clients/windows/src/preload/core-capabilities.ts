import type { VellumBridge } from "@vellumai/ipc-contract";

export const WINDOWS_CORE_CAPABILITIES = [
  "platform",
  "hostOS",
  "app",
  "commands",
  "mainWindow",
] as const satisfies readonly (keyof VellumBridge)[];

export type WindowsCoreBridge = Pick<
  VellumBridge,
  (typeof WINDOWS_CORE_CAPABILITIES)[number]
>;
