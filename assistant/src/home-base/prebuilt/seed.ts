import { createApp, listApps, type AppDefinition } from '../../memory/app-store.js';
import { getLogger } from '../../util/logger.js';
import {
  HOME_BASE_PREBUILT_DESCRIPTION_PREFIX,
  isPrebuiltHomeBaseApp,
} from '../prebuilt-home-base-updater.js';
import { PREBUILT_HOME_BASE_HTML } from './prebuilt-html.js';

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

// Inline the seed metadata so it's embedded in the compiled binary.
// readFileSync does NOT work in bun build --compile for sibling files.
const SEED_METADATA: SeedMetadata = {
  version: 'v1',
  appName: 'Home Base',
  starterTasks: [
    'Change the look and feel',
    'Research something for me about X',
    'Turn it into a webpage or interactive UI',
  ],
  onboardingTasks: [
    'Make it mine',
    'Enable voice mode',
    'Enable computer control',
    'Try ambient mode',
  ],
};

function loadSeedMetadata(): SeedMetadata {
  return SEED_METADATA;
}

function loadPrebuiltHtml(): string {
  return PREBUILT_HOME_BASE_HTML;
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
