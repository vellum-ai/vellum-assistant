import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadConfig,
  resolveProfile,
  resetCache,
  setStorePathOverride,
  type DictationProfilesConfig,
} from '../daemon/dictation-profile-store.js';

let testDir: string;
let testFilePath: string;

beforeEach(() => {
  testDir = join(tmpdir(), `vellum-test-profiles-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  testFilePath = join(testDir, 'dictation-profiles.json');
  setStorePathOverride(testFilePath);
});

afterEach(() => {
  setStorePathOverride(null);
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

function writeConfig(config: unknown): void {
  writeFileSync(testFilePath, JSON.stringify(config, null, 2));
}

describe('loadConfig', () => {
  test('returns default config when file is missing', () => {
    const config = loadConfig();
    expect(config.version).toBe(1);
    expect(config.profiles).toHaveLength(1);
    expect(config.profiles[0].id).toBe('general');
    expect(config.profiles[0].name).toBe('General');
  });

  test('returns default config for malformed JSON', () => {
    writeFileSync(join(testDir, 'dictation-profiles.json'), 'not json at all');
    const config = loadConfig();
    expect(config.profiles).toHaveLength(1);
    expect(config.profiles[0].id).toBe('general');
  });

  test('returns default config for invalid structure', () => {
    writeConfig({ version: 2, profiles: [] });
    const config = loadConfig();
    expect(config.profiles[0].id).toBe('general');
  });

  test('returns default config for non-object', () => {
    writeConfig('just a string');
    const config = loadConfig();
    expect(config.profiles[0].id).toBe('general');
  });

  test('loads valid config from disk', () => {
    const validConfig: DictationProfilesConfig = {
      version: 1,
      defaultProfileId: 'work',
      profiles: [
        { id: 'work', name: 'Work', stylePrompt: 'Be professional', dictionary: [], snippets: [] },
        { id: 'casual', name: 'Casual', stylePrompt: 'Be casual' },
      ],
    };
    writeConfig(validConfig);
    const config = loadConfig();
    expect(config.profiles).toHaveLength(2);
    expect(config.profiles[0].id).toBe('work');
    expect(config.defaultProfileId).toBe('work');
  });

  test('truncates stylePrompt exceeding 2000 chars', () => {
    const longPrompt = 'x'.repeat(3000);
    writeConfig({
      version: 1,
      profiles: [{ id: 'test', name: 'Test', stylePrompt: longPrompt }],
    });
    const config = loadConfig();
    expect(config.profiles[0].stylePrompt!.length).toBe(2000);
  });

  test('skips dictionary entries exceeding length limits', () => {
    writeConfig({
      version: 1,
      profiles: [{
        id: 'test', name: 'Test',
        dictionary: [
          { spoken: 'ok', written: 'okay' },
          { spoken: 'x'.repeat(201), written: 'bad' },
          { spoken: 'good', written: 'y'.repeat(201) },
        ],
      }],
    });
    const config = loadConfig();
    expect(config.profiles[0].dictionary).toHaveLength(1);
    expect(config.profiles[0].dictionary![0].spoken).toBe('ok');
  });

  test('skips snippets exceeding length limits', () => {
    writeConfig({
      version: 1,
      profiles: [{
        id: 'test', name: 'Test',
        snippets: [
          { trigger: 'brb', expansion: 'be right back' },
          { trigger: 'x'.repeat(201), expansion: 'bad' },
          { trigger: 'good', expansion: 'y'.repeat(5001) },
        ],
      }],
    });
    const config = loadConfig();
    expect(config.profiles[0].snippets).toHaveLength(1);
    expect(config.profiles[0].snippets![0].trigger).toBe('brb');
  });

  test('enforces max 50 profiles', () => {
    const profiles = Array.from({ length: 60 }, (_, i) => ({
      id: `p${i}`, name: `Profile ${i}`,
    }));
    writeConfig({ version: 1, profiles });
    const config = loadConfig();
    expect(config.profiles).toHaveLength(50);
  });

  test('enforces max 500 dictionary entries per profile', () => {
    const dictionary = Array.from({ length: 510 }, (_, i) => ({
      spoken: `word${i}`, written: `replacement${i}`,
    }));
    writeConfig({
      version: 1,
      profiles: [{ id: 'test', name: 'Test', dictionary }],
    });
    const config = loadConfig();
    expect(config.profiles[0].dictionary).toHaveLength(500);
  });

  test('enforces max 200 snippets per profile', () => {
    const snippets = Array.from({ length: 210 }, (_, i) => ({
      trigger: `trigger${i}`, expansion: `expansion${i}`,
    }));
    writeConfig({
      version: 1,
      profiles: [{ id: 'test', name: 'Test', snippets }],
    });
    const config = loadConfig();
    expect(config.profiles[0].snippets).toHaveLength(200);
  });
});

describe('resolveProfile', () => {
  test('explicit request profileId wins over everything', () => {
    writeConfig({
      version: 1,
      defaultProfileId: 'default-one',
      appMappings: [{ profileId: 'mapped', bundleIdentifier: 'com.test.app' }],
      profiles: [
        { id: 'requested', name: 'Requested' },
        { id: 'mapped', name: 'Mapped' },
        { id: 'default-one', name: 'Default' },
      ],
    });
    const result = resolveProfile('com.test.app', 'Test App', 'requested');
    expect(result.profile.id).toBe('requested');
    expect(result.source).toBe('request');
  });

  test('app mapping by bundleIdentifier beats appName', () => {
    writeConfig({
      version: 1,
      appMappings: [
        { profileId: 'by-name', appName: 'Slack' },
        { profileId: 'by-bundle', bundleIdentifier: 'com.tinyspeck.slackmacgap' },
      ],
      profiles: [
        { id: 'by-name', name: 'By Name' },
        { id: 'by-bundle', name: 'By Bundle' },
      ],
    });
    const result = resolveProfile('com.tinyspeck.slackmacgap', 'Slack');
    expect(result.profile.id).toBe('by-bundle');
    expect(result.source).toBe('app_mapping');
  });

  test('first declared mapping wins within same specificity', () => {
    writeConfig({
      version: 1,
      appMappings: [
        { profileId: 'first', bundleIdentifier: 'com.test.app' },
        { profileId: 'second', bundleIdentifier: 'com.test.app' },
      ],
      profiles: [
        { id: 'first', name: 'First' },
        { id: 'second', name: 'Second' },
      ],
    });
    const result = resolveProfile('com.test.app', 'Test App');
    expect(result.profile.id).toBe('first');
  });

  test('falls back to appName mapping when bundleId does not match', () => {
    writeConfig({
      version: 1,
      appMappings: [
        { profileId: 'by-name', appName: 'Notes' },
      ],
      profiles: [
        { id: 'by-name', name: 'Notes Profile' },
      ],
    });
    const result = resolveProfile('com.apple.Notes', 'Notes');
    expect(result.profile.id).toBe('by-name');
    expect(result.source).toBe('app_mapping');
  });

  test('falls back to defaultProfileId when no mapping matches', () => {
    writeConfig({
      version: 1,
      defaultProfileId: 'my-default',
      profiles: [
        { id: 'my-default', name: 'My Default' },
      ],
    });
    const result = resolveProfile('com.unknown.app', 'Unknown');
    expect(result.profile.id).toBe('my-default');
    expect(result.source).toBe('default');
  });

  test('falls back to built-in general when nothing matches', () => {
    writeConfig({
      version: 1,
      profiles: [
        { id: 'some-profile', name: 'Some' },
      ],
    });
    const result = resolveProfile('com.unknown.app', 'Unknown');
    expect(result.profile.id).toBe('general');
    expect(result.source).toBe('fallback');
  });

  test('skips disabled profiles in resolution', () => {
    writeConfig({
      version: 1,
      defaultProfileId: 'disabled-one',
      profiles: [
        { id: 'disabled-one', name: 'Disabled', enabled: false },
        { id: 'enabled-one', name: 'Enabled', enabled: true },
      ],
    });
    // Request for disabled profile falls through
    const result = resolveProfile('com.test.app', 'Test', 'disabled-one');
    expect(result.profile.id).toBe('general');
    expect(result.source).toBe('fallback');
  });

  test('skips disabled profile in app mapping', () => {
    writeConfig({
      version: 1,
      appMappings: [{ profileId: 'disabled', bundleIdentifier: 'com.test.app' }],
      profiles: [
        { id: 'disabled', name: 'Disabled', enabled: false },
      ],
    });
    const result = resolveProfile('com.test.app', 'Test App');
    expect(result.profile.id).toBe('general');
    expect(result.source).toBe('fallback');
  });

  test('skips disabled default profile', () => {
    writeConfig({
      version: 1,
      defaultProfileId: 'disabled',
      profiles: [
        { id: 'disabled', name: 'Disabled', enabled: false },
      ],
    });
    const result = resolveProfile('com.test.app', 'Test App');
    expect(result.profile.id).toBe('general');
    expect(result.source).toBe('fallback');
  });
});
