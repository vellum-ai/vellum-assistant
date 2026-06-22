import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { z } from "zod";

import { isAllowedOrigin, resolveAllowedOrigin } from "./app-origin";

/**
 * Registration helpers for the renderer→main IPC surface.
 *
 * Every channel the renderer can reach is a trust boundary: the handler
 * runs privileged main-process code (spawning the CLI, writing the
 * lockfile, reading guardian tokens, opening external URLs) on behalf
 * of whatever frame sent the message. Two checks gate every channel,
 * applied here so an individual handler can't forget one:
 *
 *   1. Sender origin — the message must come from a frame running at
 *      the build's renderer origin (`app://vellum.ai` packaged, the
 *      `VELLUM_DEV_URL` origin in dev). A frame that navigated or was
 *      injected elsewhere is rejected before the handler body runs.
 *   2. Input shape — the argument tuple is parsed against a Zod schema,
 *      so a handler only ever sees a value of the type it declares.
 *
 * The renderer and main process ship in the same app bundle, so there
 * is no version skew across this boundary (unlike the macOS↔CLI lockfile
 * contract, which is deliberately permissive). A malformed or unexpected
 * payload here is a programming error or a hostile sender, so the right
 * response is to reject, not to coerce. A channel that intentionally
 * tolerates a missing argument encodes that in its schema (an
 * `.optional()` tuple element), keeping the contract explicit.
 *
 * Reference: Electron security checklist, "Validate the sender of all
 * IPC messages" —
 * https://www.electronjs.org/docs/latest/tutorial/security#17-validate-the-sender-of-all-ipc-messages
 */

const isAllowedSender = (event: IpcMainEvent | IpcMainInvokeEvent): boolean =>
  isAllowedOrigin(event.senderFrame?.origin, resolveAllowedOrigin());

/**
 * Register an invocable (`ipcRenderer.invoke`) handler. Rejects the
 * renderer's promise when the sender origin or the argument shape fails
 * validation; otherwise dispatches the parsed argument tuple to `fn`.
 */
export const handle = <Args extends unknown[], R>(
  channel: string,
  schema: z.ZodType<Args>,
  fn: (args: Args, event: IpcMainInvokeEvent) => R,
): void => {
  ipcMain.handle(channel, (event, ...args: unknown[]): R => {
    if (!isAllowedSender(event)) {
      throw new Error(`Rejected ${channel}: sender is not the app renderer`);
    }
    return fn(schema.parse(args), event);
  });
};

/**
 * Register a fire-and-forget (`ipcRenderer.send`) listener. Same guards
 * as `handle`, but with no return channel, so a rejected sender or a
 * malformed payload drops the message silently — the correct outcome for
 * the accounting messages that use this path (there's no promise to
 * reject).
 */
/**
 * Register a synchronous (`ipcRenderer.sendSync`) handler. Same sender
 * validation as `handle`/`on`; returns `null` for rejected senders so the
 * renderer's `sendSync` never hangs.
 */
export const handleSync = <R>(
  channel: string,
  fn: () => R,
): void => {
  ipcMain.on(channel, (event) => {
    event.returnValue = isAllowedSender(event) ? fn() : null;
  });
};

export const on = <Args extends unknown[]>(
  channel: string,
  schema: z.ZodType<Args>,
  fn: (args: Args, event: IpcMainEvent) => void,
): void => {
  ipcMain.on(channel, (event, ...args: unknown[]) => {
    if (!isAllowedSender(event)) return;
    const parsed = schema.safeParse(args);
    if (!parsed.success) return;
    fn(parsed.data, event);
  });
};
