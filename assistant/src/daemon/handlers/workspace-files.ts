import * as net from 'node:net';
import { readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathExists } from '../../util/fs.js';
import { getWorkspaceDir } from '../../util/platform.js';
import { log, defineHandlers, type HandlerContext } from './shared.js';
import type { WorkspaceFileReadRequest } from '../ipc-protocol.js';

/** Well-known workspace prompt files shown in the Identity panel. */
const WORKSPACE_FILES = ['IDENTITY.md', 'SOUL.md', 'USER.md', 'skills/'];

function handleWorkspaceFilesList(socket: net.Socket, ctx: HandlerContext): void {
  const base = getWorkspaceDir();
  const files = WORKSPACE_FILES.map((name) => ({
    path: name,
    name,
    exists: pathExists(join(base, name)),
  }));
  ctx.send(socket, { type: 'workspace_files_list_response', files });
}

function handleWorkspaceFileRead(
  msg: WorkspaceFileReadRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const base = getWorkspaceDir();
  const requested = msg.path;

  // Prevent path traversal — reject paths that escape the workspace root.
  // Use resolve() to canonicalize and check with trailing separator to prevent
  // sibling directory prefix matches (e.g. "../workspace-evil/secret").
  const resolved = resolve(base, requested);
  if (!resolved.startsWith(base + sep) && resolved !== base) {
    log.warn({ path: requested }, 'Workspace file read blocked: path traversal attempt');
    ctx.send(socket, {
      type: 'workspace_file_read_response',
      path: requested,
      content: null,
      error: 'Invalid path',
    });
    return;
  }

  try {
    if (!pathExists(resolved)) {
      ctx.send(socket, {
        type: 'workspace_file_read_response',
        path: requested,
        content: null,
        error: 'File not found',
      });
      return;
    }
    const content = readFileSync(resolved, 'utf-8');
    ctx.send(socket, {
      type: 'workspace_file_read_response',
      path: requested,
      content,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, path: requested }, 'Failed to read workspace file');
    ctx.send(socket, {
      type: 'workspace_file_read_response',
      path: requested,
      content: null,
      error: message,
    });
  }
}

export const workspaceFileHandlers = defineHandlers({
  workspace_files_list: (_msg, socket, ctx) => handleWorkspaceFilesList(socket, ctx),
  workspace_file_read: handleWorkspaceFileRead,
});
