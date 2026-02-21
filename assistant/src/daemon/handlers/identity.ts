import * as net from 'node:net';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getWorkspacePromptPath } from '../../util/platform.js';
import { log, defineHandlers, type HandlerContext } from './shared.js';

function handleIdentityGet(socket: net.Socket, ctx: HandlerContext): void {
  const identityPath = getWorkspacePromptPath('IDENTITY.md');

  if (!existsSync(identityPath)) {
    ctx.send(socket, {
      type: 'identity_get_response',
      found: false,
      name: '',
      role: '',
      personality: '',
      emoji: '',
      home: '',
    });
    return;
  }

  try {
    const content = readFileSync(identityPath, 'utf-8');
    const fields: Record<string, string> = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      const lower = trimmed.toLowerCase();
      const extract = (prefix: string): string | null => {
        if (!lower.startsWith(prefix)) return null;
        return trimmed.split(':**').pop()?.trim() ?? null;
      };

      const name = extract('- **name:**');
      if (name) { fields.name = name; continue; }
      const role = extract('- **role:**');
      if (role) { fields.role = role; continue; }
      const personality = extract('- **personality:**') ?? extract('- **vibe:**');
      if (personality) { fields.personality = personality; continue; }
      const emoji = extract('- **emoji:**');
      if (emoji) { fields.emoji = emoji; continue; }
      const home = extract('- **home:**');
      if (home) { fields.home = home; continue; }
    }

    // Read version from package.json
    let version: string | undefined;
    try {
      const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '../../../package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      version = pkg.version;
    } catch {
      // ignore
    }

    // Read createdAt from IDENTITY.md file birthtime
    let createdAt: string | undefined;
    try {
      const stats = statSync(identityPath);
      createdAt = stats.birthtime.toISOString();
    } catch {
      // ignore
    }

    // Read lockfile for assistantId, cloud, and originSystem
    let assistantId: string | undefined;
    let cloud: string | undefined;
    let originSystem: string | undefined;
    try {
      const homedir = process.env.HOME ?? process.env.USERPROFILE ?? '';
      const lockfilePaths = [
        join(homedir, '.vellum.lock.json'),
        join(homedir, '.vellum.lockfile.json'),
      ];
      for (const lockPath of lockfilePaths) {
        if (!existsSync(lockPath)) continue;
        const lockData = JSON.parse(readFileSync(lockPath, 'utf-8'));
        const assistants = lockData.assistants as Array<Record<string, unknown>> | undefined;
        if (assistants && assistants.length > 0) {
          // Use the most recently hatched assistant
          const sorted = [...assistants].sort((a, b) => {
            const dateA = new Date(a.hatchedAt as string || 0).getTime();
            const dateB = new Date(b.hatchedAt as string || 0).getTime();
            return dateB - dateA;
          });
          const latest = sorted[0];
          assistantId = latest.assistantId as string | undefined;
          cloud = latest.cloud as string | undefined;
          originSystem = cloud === 'local' ? 'local' : cloud;
        }
        break;
      }
    } catch {
      // ignore — lockfile may not exist
    }

    ctx.send(socket, {
      type: 'identity_get_response',
      found: true,
      name: fields.name ?? '',
      role: fields.role ?? '',
      personality: fields.personality ?? '',
      emoji: fields.emoji ?? '',
      home: fields.home ?? '',
      version,
      assistantId,
      createdAt,
      originSystem,
    });
  } catch (err) {
    log.error({ err }, 'Failed to read identity');
    ctx.send(socket, {
      type: 'identity_get_response',
      found: false,
      name: '',
      role: '',
      personality: '',
      emoji: '',
      home: '',
    });
  }
}

export const identityHandlers = defineHandlers({
  identity_get: (_msg, socket, ctx) => handleIdentityGet(socket, ctx),
});
