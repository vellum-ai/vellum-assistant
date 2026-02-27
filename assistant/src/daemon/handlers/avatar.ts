import * as net from 'node:net';

import type { GenerateAvatarRequest } from '../ipc-contract/settings.js';
import { setAvatarTool } from '../../tools/system/avatar-generator.js';
import { getWorkspaceDir } from '../../util/platform.js';
import { join } from 'node:path';
import { defineHandlers, type HandlerContext, log } from './shared.js';

/**
 * Handle a client request to generate a custom avatar via DALL-E.
 * Invokes the set_avatar tool directly, sends a response to the requesting
 * client, and broadcasts avatar_updated to all clients on success.
 */
async function handleGenerateAvatar(
  msg: GenerateAvatarRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  const description = msg.description?.trim();
  if (!description) {
    ctx.send(socket, {
      type: 'generate_avatar_response',
      success: false,
      error: 'Description is required.',
    });
    return;
  }

  log.info({ description }, 'Generating avatar via IPC request');

  try {
    const result = await setAvatarTool.execute(
      { description },
      // Minimal tool context — avatar generation needs no session context
      {} as Parameters<typeof setAvatarTool.execute>[1],
    );

    if (result.isError) {
      ctx.send(socket, {
        type: 'generate_avatar_response',
        success: false,
        error: result.content,
      });
      return;
    }

    // Broadcast avatar change to all connected clients
    const avatarPath = join(getWorkspaceDir(), 'data', 'avatar', 'custom-avatar.png');
    ctx.broadcast({ type: 'avatar_updated', avatarPath });

    ctx.send(socket, {
      type: 'generate_avatar_response',
      success: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ error: message }, 'Avatar generation failed unexpectedly');
    ctx.send(socket, {
      type: 'generate_avatar_response',
      success: false,
      error: message,
    });
  }
}

export const avatarHandlers = defineHandlers({
  generate_avatar: handleGenerateAvatar,
});
