import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { SessionTransportMetadata } from '../../daemon/ipc-protocol.js';
import { getLogger } from '../../util/logger.js';
import {
  getOnboardingPlaybooksDir,
  markChannelStarted,
  readOnboardingRegistry,
  scheduleRegistryRepair,
  writeOnboardingRegistry,
} from './registry.js';
import { reconcilePlaybook } from './reconcile.js';

const log = getLogger('onboarding-playbook-manager');

export interface OnboardingReconciliationSummary {
  firstTimeFastPath: boolean;
  attempted: boolean;
  sourceChannels: string[];
  reconciledSteps: string[];
  crossPlaybookReads: number;
}

export interface ResolvedOnboardingPlaybook {
  channelId: string;
  playbookPath: string;
  playbookName: string;
  playbookContent: string;
  uxBrief?: string;
  hints: string[];
  guidanceBullets: string[];
  reconciliation: OnboardingReconciliationSummary;
}

export const DEFAULT_CHANNEL_ID = 'desktop';

function defaultsDir(): string {
  return join(import.meta.dirname ?? __dirname, 'defaults');
}

function normalizeChannelId(channelId: string | undefined | null): string {
  if (!channelId) return DEFAULT_CHANNEL_ID;
  const normalized = channelId
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized.length > 0 ? normalized : DEFAULT_CHANNEL_ID;
}

function pickDefaultTemplate(channelId: string): string {
  if (channelId === 'desktop' || channelId === 'macos' || channelId === 'mac') {
    return 'desktop_onboarding.md';
  }
  if (channelId === 'telegram') {
    return 'telegram_onboarding.md';
  }
  if (channelId === 'mobile' || channelId === 'ios' || channelId === 'android') {
    return 'mobile_onboarding.md';
  }
  return 'mobile_onboarding.md';
}

function extractGuidanceBullets(markdown: string): string[] {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === '## Channel Guidance');
  if (start === -1) return [];
  const bullets: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('## ')) break;
    if (!line.startsWith('- ')) continue;
    bullets.push(line.slice(2).trim());
  }
  return bullets;
}

function ensurePlaybookSeeded(channelId: string): string {
  const playbooksDir = getOnboardingPlaybooksDir();
  if (!existsSync(playbooksDir)) {
    mkdirSync(playbooksDir, { recursive: true });
  }

  const playbookPath = join(playbooksDir, `${channelId}_onboarding.md`);
  if (existsSync(playbookPath)) return playbookPath;

  const template = pickDefaultTemplate(channelId);
  const templatePath = join(defaultsDir(), template);
  if (existsSync(templatePath)) {
    copyFileSync(templatePath, playbookPath);
    return playbookPath;
  }

  // Defensive fallback: should never happen if defaults are bundled.
  writeFileSync(
    playbookPath,
    `# ${channelId} Onboarding Playbook\n\n## Checklist\n- [ ] Reconcile onboarding progress across channels\n`,
    'utf-8',
  );
  return playbookPath;
}

function readPlaybook(path: string): string {
  if (!existsSync(path)) return '';
  try {
    return readFileSync(path, 'utf-8');
  } catch (err) {
    log.warn({ err, path }, 'Failed to read onboarding playbook');
    return '';
  }
}

function normalizeHints(hints: string[] | undefined): string[] {
  if (!hints) return [];
  return hints
    .map((hint) => hint.trim())
    .filter((hint) => hint.length > 0);
}

export function resolveOnboardingPlaybook(
  transport: SessionTransportMetadata | undefined,
): ResolvedOnboardingPlaybook {
  const channelId = normalizeChannelId(transport?.channelId);
  const playbookPath = ensurePlaybookSeeded(channelId);

  const registryResult = readOnboardingRegistry();
  const hadReadError = registryResult.hadReadError;
  if (hadReadError) {
    scheduleRegistryRepair();
  }

  const registry = registryResult.registry;
  const startedElsewhere = Object.keys(registry.startedChannels)
    .filter((id) => id !== channelId)
    .sort();
  const firstTimeFastPath = startedElsewhere.length === 0;

  let playbookContent = readPlaybook(playbookPath);
  const sourceChannels: string[] = [];
  let reconciledSteps: string[] = [];
  let crossPlaybookReads = 0;

  if (!firstTimeFastPath) {
    const sources = startedElsewhere.flatMap((startedChannel) => {
      const entry = registry.startedChannels[startedChannel];
      if (!entry?.playbookPath) return [];
      const sourceContent = readPlaybook(entry.playbookPath);
      if (sourceContent.length === 0) return [];
      crossPlaybookReads += 1;
      return [{ channelId: startedChannel, content: sourceContent }];
    });

    const reconciled = reconcilePlaybook({
      currentChannelId: channelId,
      currentContent: playbookContent,
      sources,
    });
    if (reconciled.changed) {
      writeFileSync(playbookPath, reconciled.reconciledContent, 'utf-8');
      playbookContent = reconciled.reconciledContent;
      reconciledSteps = reconciled.reconciledSteps;
      sourceChannels.push(...reconciled.sourceChannels);
    }
  }

  const nextRegistry = markChannelStarted(registry, channelId, playbookPath);
  if (hadReadError) {
    queueMicrotask(() => {
      try {
        writeOnboardingRegistry(nextRegistry);
      } catch (err) {
        log.warn({ err }, 'Failed to asynchronously write onboarding registry after read failure');
      }
    });
  } else {
    writeOnboardingRegistry(nextRegistry);
  }

  return {
    channelId,
    playbookPath,
    playbookName: basename(playbookPath),
    playbookContent,
    uxBrief: transport?.uxBrief?.trim() || undefined,
    hints: normalizeHints(transport?.hints),
    guidanceBullets: extractGuidanceBullets(playbookContent),
    reconciliation: {
      firstTimeFastPath,
      attempted: !firstTimeFastPath,
      sourceChannels,
      reconciledSteps,
      crossPlaybookReads,
    },
  };
}

export function refreshPlaybookContent(path: string): string {
  return readPlaybook(path);
}
