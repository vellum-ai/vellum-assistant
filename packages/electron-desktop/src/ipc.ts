import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { z } from "zod";

import { isAllowedOrigin, type AllowedOrigin } from "./app-origin";

export type AllowedOriginResolver = () => AllowedOrigin;
export type OriginValidator = typeof isAllowedOrigin;
export type IpcHandle = <Args extends unknown[], Result>(
  channel: string,
  schema: z.ZodType<Args>,
  fn: (args: Args, event: IpcMainInvokeEvent) => Result,
) => void;
export type IpcOn = <Args extends unknown[]>(
  channel: string,
  schema: z.ZodType<Args>,
  fn: (args: Args, event: IpcMainEvent) => void,
) => void;

/**
 * Registration helpers for the renderer-to-main IPC surface.
 *
 * Every channel the renderer can reach is a trust boundary: the handler runs
 * privileged main-process code on behalf of the frame that sent the message.
 * The sender origin and argument tuple are validated before dispatch.
 */
export const createIpcRegistrar = (
  resolveAllowedOrigin: AllowedOriginResolver,
  validateOrigin: OriginValidator = isAllowedOrigin,
) => {
  const isAllowedSender = (event: IpcMainEvent | IpcMainInvokeEvent): boolean =>
    validateOrigin(event.senderFrame?.origin, resolveAllowedOrigin());

  /** Register an invocable handler with sender and argument validation. */
  const handle: IpcHandle = (channel, schema, fn): void => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!isAllowedSender(event)) {
        throw new Error(`Rejected ${channel}: sender is not the app renderer`);
      }
      return fn(schema.parse(args), event);
    });
  };

  /** Register a synchronous handler that returns null for rejected senders. */
  const handleSync = <R>(channel: string, fn: () => R): void => {
    ipcMain.on(channel, (event) => {
      event.returnValue = isAllowedSender(event) ? fn() : null;
    });
  };

  /** Register a fire-and-forget listener that drops invalid messages. */
  const on: IpcOn = (channel, schema, fn): void => {
    ipcMain.on(channel, (event, ...args: unknown[]) => {
      if (!isAllowedSender(event)) {
        return;
      }
      const parsed = schema.safeParse(args);
      if (!parsed.success) {
        return;
      }
      fn(parsed.data, event);
    });
  };

  return { handle, handleSync, on };
};

export type IpcRegistrar = ReturnType<typeof createIpcRegistrar>;
