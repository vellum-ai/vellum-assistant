import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveOnboardingPlaybook,
} from '../onboarding/playbooks/manager.js';
import {
  getOnboardingPlaybooksDir,
  getOnboardingRegistryPath,
} from '../onboarding/playbooks/registry.js';

let testBaseDir = '';
const previousBaseDataDir = process.env.BASE_DATA_DIR;

function channelPlaybookPath(channelId: string): string {
  return join(getOnboardingPlaybooksDir(), `${channelId}_onboarding.md`);
}

describe('onboarding playbook manager', () => {
  beforeEach(() => {
    testBaseDir = join(tmpdir(), `onboarding-playbook-manager-${randomUUID()}`);
    mkdirSync(testBaseDir, { recursive: true });
    process.env.BASE_DATA_DIR = testBaseDir;
  });

  afterEach(() => {
    if (testBaseDir) {
      rmSync(testBaseDir, { recursive: true, force: true });
    }
    if (previousBaseDataDir === undefined) {
      delete process.env.BASE_DATA_DIR;
    } else {
      process.env.BASE_DATA_DIR = previousBaseDataDir;
    }
  });

  test('uses first-time fast path with zero cross-playbook reads', () => {
    const resolved = resolveOnboardingPlaybook({ channelId: 'desktop' });

    expect(resolved.channelId).toBe('desktop');
    expect(resolved.reconciliation.firstTimeFastPath).toBe(true);
    expect(resolved.reconciliation.crossPlaybookReads).toBe(0);
    expect(existsSync(resolved.playbookPath)).toBe(true);

    const registryPath = getOnboardingRegistryPath();
    const registry = JSON.parse(readFileSync(registryPath, 'utf-8')) as {
      startedChannels: Record<string, { channelId: string }>;
    };
    expect(registry.startedChannels.desktop.channelId).toBe('desktop');
  });

  test('reconciles against previously started channels only', () => {
    const desktop = resolveOnboardingPlaybook({ channelId: 'desktop' });

    const desktopUpdated = readFileSync(desktop.playbookPath, 'utf-8')
      .replace('- [ ] Start talking to your assistant', '- [x] Start talking to your assistant')
      .replace('- [ ] Define assistant identity and personality', '- [x] Define assistant identity and personality');
    writeFileSync(desktop.playbookPath, desktopUpdated, 'utf-8');

    const telegram = resolveOnboardingPlaybook({ channelId: 'telegram' });

    expect(telegram.reconciliation.firstTimeFastPath).toBe(false);
    expect(telegram.reconciliation.attempted).toBe(true);
    expect(telegram.reconciliation.crossPlaybookReads).toBe(1);
    expect(telegram.reconciliation.sourceChannels).toEqual(['desktop']);

    const telegramContent = readFileSync(channelPlaybookPath('telegram'), 'utf-8');
    expect(telegramContent).toContain('- [x] Start talking to your assistant');
    expect(telegramContent).toContain('## Reconciliation Audit');
  });

  test('registry read failures fail open to fast path and repair asynchronously', async () => {
    const registryPath = getOnboardingRegistryPath();
    mkdirSync(dirname(registryPath), { recursive: true });
    writeFileSync(registryPath, '{not-valid-json', 'utf-8');

    const resolved = resolveOnboardingPlaybook({ channelId: 'mobile' });
    expect(resolved.reconciliation.firstTimeFastPath).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 0));

    const repaired = JSON.parse(readFileSync(registryPath, 'utf-8')) as {
      startedChannels: Record<string, { channelId: string }>;
    };
    expect(repaired.startedChannels.mobile.channelId).toBe('mobile');
  });
});
