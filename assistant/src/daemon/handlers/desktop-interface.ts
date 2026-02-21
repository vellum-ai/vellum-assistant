import * as fs from 'node:fs';
import * as net from 'node:net';
import { join } from 'node:path';
import type { DesktopInterfaceGetRequest } from '../ipc-protocol.js';
import { getInterfacesDir } from '../../util/platform.js';
import { log, defineHandlers, type HandlerContext } from './shared.js';

export function handleDesktopInterfaceGet(
  _msg: DesktopInterfaceGetRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    const filePath = join(getInterfacesDir(), 'vellum-desktop', 'index.html');
    let html: string | null = null;
    if (fs.existsSync(filePath)) {
      html = fs.readFileSync(filePath, 'utf8');
    }
    ctx.send(socket, { type: 'desktop_interface_get_response', html });
  } catch (err) {
    log.error({ err }, 'Failed to read desktop interface');
    ctx.send(socket, { type: 'desktop_interface_get_response', html: null });
  }
}

export const desktopInterfaceHandlers = defineHandlers({
  desktop_interface_get: handleDesktopInterfaceGet,
});
