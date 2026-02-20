import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp, listApps, type AppDefinition } from '../../memory/app-store.js';
import { getLogger } from '../../util/logger.js';
import {
  HOME_BASE_PREBUILT_DESCRIPTION_PREFIX,
  isPrebuiltHomeBaseApp,
} from '../prebuilt-home-base-updater.js';

const log = getLogger('home-base-seed');

interface SeedMetadata {
  version: string;
  appName: string;
  starterTasks: string[];
  onboardingTasks: string[];
}

export interface PrebuiltHomeBaseTaskPayload {
  starterTasks: string[];
  onboardingTasks: string[];
}

function getPrebuiltDir(): string {
  return import.meta.dirname ?? __dirname;
}

function loadSeedMetadata(): SeedMetadata {
  const raw = readFileSync(join(getPrebuiltDir(), 'seed-metadata.json'), 'utf-8');
  return JSON.parse(raw) as SeedMetadata;
}

function loadPrebuiltHtml(): string {
  return readFileSync(join(getPrebuiltDir(), 'index.html'), 'utf-8');
}

function buildDescription(metadata: SeedMetadata): string {
  return [
    `${HOME_BASE_PREBUILT_DESCRIPTION_PREFIX} ${metadata.version}`,
    'Prebuilt Home Base dashboard scaffold seeded during onboarding/bootstrap.',
    `Starter tasks: ${metadata.starterTasks.join(', ')}`,
    `Onboarding tasks: ${metadata.onboardingTasks.join(', ')}`,
  ].join(' ');
}

export function findSeededHomeBaseApp(): AppDefinition | null {
  const apps = listApps();
  for (const app of apps) {
    if (isPrebuiltHomeBaseApp(app)) {
      return app;
    }
  }
  return null;
}

export function getPrebuiltHomeBasePreview(): {
  title: string;
  subtitle: string;
  description: string;
  icon: string;
  metrics: Array<{ label: string; value: string }>;
} {
  return {
    title: 'Home Base',
    subtitle: 'Dashboard',
    description: 'Prebuilt onboarding + starter task canvas',
    icon: '🏠',
    metrics: [
      { label: 'Starter tasks', value: '3' },
      { label: 'Onboarding tasks', value: '4' },
    ],
  };
}

export function getPrebuiltHomeBaseTaskPayload(): PrebuiltHomeBaseTaskPayload {
  const metadata = loadSeedMetadata();
  return {
    starterTasks: metadata.starterTasks,
    onboardingTasks: metadata.onboardingTasks,
  };
}

export function ensurePrebuiltHomeBaseSeeded(): { appId: string; created: boolean } {
  const existing = findSeededHomeBaseApp();
  if (existing) {
    return { appId: existing.id, created: false };
  }

  const metadata = loadSeedMetadata();
  const html = loadPrebuiltHtml();
  const created = createApp({
    name: metadata.appName,
    description: buildDescription(metadata),
    schemaJson: '{}',
    htmlDefinition: html,
    appType: 'app',
  });

  log.info({ appId: created.id }, 'Seeded prebuilt Home Base app');
  return { appId: created.id, created: true };
}
