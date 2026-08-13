import type { createIpcRegistrar } from "./ipc";

type IpcRegistrar = ReturnType<typeof createIpcRegistrar>;

export interface PresenceLogger {
  info: (...args: unknown[]) => void;
}

let ipc: Pick<IpcRegistrar, "handle" | "on"> | null = null;
let logger: PresenceLogger = console;

export const configurePresenceRuntime = (runtime: {
  ipc: Pick<IpcRegistrar, "handle" | "on">;
  logger: PresenceLogger;
}): void => {
  ipc = runtime.ipc;
  logger = runtime.logger;
};

export const handle: IpcRegistrar["handle"] = (...args) => {
  if (!ipc) {
    throw new Error("Presence IPC is not configured");
  }
  ipc.handle(...args);
};

export const on: IpcRegistrar["on"] = (...args) => {
  if (!ipc) {
    throw new Error("Presence IPC is not configured");
  }
  ipc.on(...args);
};

export const log: PresenceLogger = {
  info: (...args) => logger.info(...args),
};
