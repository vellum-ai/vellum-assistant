import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getWorkspaceDir } from '../../util/platform.js';
import { getLogger } from '../../util/logger.js';

const log = getLogger('onboarding-playbook-registry');

export interface OnboardingRegistryEntry {
  channelId: string;
  playbookPath: string;
  startedAt: string;
  updatedAt: string;
}

export interface OnboardingRegistry {
  version: 1;
  startedChannels: Record<string, OnboardingRegistryEntry>;
}

export interface RegistryReadResult {
  path: string;
  registry: OnboardingRegistry;
  hadReadError: boolean;
}

function createEmptyRegistry(): OnboardingRegistry {
  return {
    version: 1,
    startedChannels: {},
  };
}

export function getOnboardingPlaybooksDir(): string {
  return join(getWorkspaceDir(), 'onboarding', 'playbooks');
}

export function getOnboardingRegistryPath(): string {
  return join(getOnboardingPlaybooksDir(), 'registry.json');
}

function ensurePlaybookDirectory(): void {
  const dir = getOnboardingPlaybooksDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function isRegistryEntry(value: unknown): value is OnboardingRegistryEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.channelId === 'string'
    && typeof entry.playbookPath === 'string'
    && typeof entry.startedAt === 'string'
    && typeof entry.updatedAt === 'string'
  );
}

function normalizeRegistry(value: unknown): OnboardingRegistry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return null;
  const startedChannels = record.startedChannels;
  if (!startedChannels || typeof startedChannels !== 'object' || Array.isArray(startedChannels)) {
    return null;
  }

  const normalized: Record<string, OnboardingRegistryEntry> = {};
  for (const [channelId, entry] of Object.entries(startedChannels as Record<string, unknown>)) {
    if (!isRegistryEntry(entry)) return null;
    normalized[channelId] = entry;
  }

  return {
    version: 1,
    startedChannels: normalized,
  };
}

export function readOnboardingRegistry(): RegistryReadResult {
  ensurePlaybookDirectory();
  const path = getOnboardingRegistryPath();
  if (!existsSync(path)) {
    return {
      path,
      registry: createEmptyRegistry(),
      hadReadError: false,
    };
  }

  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    const normalized = normalizeRegistry(parsed);
    if (normalized) {
      return {
        path,
        registry: normalized,
        hadReadError: false,
      };
    }
    log.warn({ path }, 'Onboarding registry invalid, using empty fallback');
  } catch (err) {
    log.warn({ err, path }, 'Failed to read onboarding registry, using empty fallback');
  }

  return {
    path,
    registry: createEmptyRegistry(),
    hadReadError: true,
  };
}

export function writeOnboardingRegistry(registry: OnboardingRegistry): void {
  ensurePlaybookDirectory();
  const path = getOnboardingRegistryPath();
  const parent = dirname(path);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(registry, null, 2) + '\n', 'utf-8');
}

export function scheduleRegistryRepair(): void {
  queueMicrotask(() => {
    try {
      writeOnboardingRegistry(createEmptyRegistry());
      log.info('Repaired onboarding registry with empty default');
    } catch (err) {
      log.warn({ err }, 'Failed to repair onboarding registry');
    }
  });
}

export function markChannelStarted(
  registry: OnboardingRegistry,
  channelId: string,
  playbookPath: string,
  now: Date = new Date(),
): OnboardingRegistry {
  const nextStartedChannels: Record<string, OnboardingRegistryEntry> = {
    ...registry.startedChannels,
  };

  const existing = nextStartedChannels[channelId];
  const timestamp = now.toISOString();

  nextStartedChannels[channelId] = {
    channelId,
    playbookPath,
    startedAt: existing?.startedAt ?? timestamp,
    updatedAt: timestamp,
  };

  return {
    version: 1,
    startedChannels: nextStartedChannels,
  };
}
