/**
 * Identity and health endpoint handlers.
 */

import { existsSync, readFileSync, statfsSync,statSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getBaseDataDir } from '../../config/env-registry.js';
import { getWorkspacePromptPath, readLockfile } from '../../util/platform.js';
import { httpError } from '../http-errors.js';

interface DiskSpaceInfo {
  path: string;
  totalMb: number;
  usedMb: number;
  freeMb: number;
}

function getDiskSpaceInfo(): DiskSpaceInfo | null {
  try {
    const baseDataDir = getBaseDataDir();
    const diskPath = baseDataDir && existsSync(baseDataDir) ? baseDataDir : '/';
    const stats = statfsSync(diskPath);
    const totalBytes = stats.bsize * stats.blocks;
    const freeBytes = stats.bsize * stats.bavail;
    const bytesToMb = (b: number) => Math.round((b / (1024 * 1024)) * 100) / 100;
    return {
      path: diskPath,
      totalMb: bytesToMb(totalBytes),
      usedMb: bytesToMb(totalBytes - freeBytes),
      freeMb: bytesToMb(freeBytes),
    };
  } catch {
    return null;
  }
}

interface MemoryInfo {
  currentMb: number;
  maxMb: number;
}

function getMemoryInfo(): MemoryInfo {
  const bytesToMb = (b: number) => Math.round((b / (1024 * 1024)) * 100) / 100;
  return {
    currentMb: bytesToMb(process.memoryUsage().rss),
    maxMb: bytesToMb(totalmem()),
  };
}

interface CpuInfo {
  currentPercent: number;
  maxCores: number;
}

function getCpuInfo(): CpuInfo {
  const usage = process.cpuUsage();
  const uptimeMs = process.uptime() * 1000;
  const cpuMs = (usage.user + usage.system) / 1000;
  const numCores = cpus().length;
  const currentPercent = uptimeMs > 0
    ? Math.round((cpuMs / (uptimeMs * numCores)) * 10000) / 100
    : 0;
  return {
    currentPercent,
    maxCores: numCores,
  };
}

function getPackageVersion(): string | undefined {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '../../../package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version;
  } catch {
    return undefined;
  }
}

export function handleHealth(): Response {
  return Response.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: getPackageVersion(),
    disk: getDiskSpaceInfo(),
    memory: getMemoryInfo(),
    cpu: getCpuInfo(),
  });
}

export function handleGetIdentity(): Response {
  const identityPath = getWorkspacePromptPath('IDENTITY.md');
  if (!existsSync(identityPath)) {
    return httpError('NOT_FOUND', 'IDENTITY.md not found', 404);
  }

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

  const version = getPackageVersion();

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
    const lockData = readLockfile();
    const assistants = lockData?.assistants as Array<Record<string, unknown>> | undefined;
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
  } catch {
    // ignore -- lockfile may not exist
  }

  return Response.json({
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
}
