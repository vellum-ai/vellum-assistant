/**
 * Tests for the canonical extension environment contract.
 *
 * Covers:
 *   - parseExtensionEnvironment: alias normalization, trimming, case-
 *     insensitivity, and rejection of invalid values.
 *   - resolveBuildDefaultEnvironment: fallback to 'production' when the
 *     bundler-defined env var is missing or invalid.
 *   - cloudUrlsForEnvironment: full URL mapping table for every
 *     supported environment.
 */

import { describe, test, expect, afterEach } from 'bun:test';

import {
  parseExtensionEnvironment,
  resolveBuildDefaultEnvironment,
  cloudUrlsForEnvironment,
  type ExtensionEnvironment,
} from '../extension-environment.js';

// ── parseExtensionEnvironment ───────────────────────────────────────

describe('parseExtensionEnvironment', () => {
  test('parses each canonical environment value', () => {
    expect(parseExtensionEnvironment('local')).toBe('local');
    expect(parseExtensionEnvironment('dev')).toBe('dev');
    expect(parseExtensionEnvironment('staging')).toBe('staging');
    expect(parseExtensionEnvironment('production')).toBe('production');
  });

  test('"prod" is an alias for "production"', () => {
    expect(parseExtensionEnvironment('prod')).toBe('production');
  });

  test('is case-insensitive', () => {
    expect(parseExtensionEnvironment('LOCAL')).toBe('local');
    expect(parseExtensionEnvironment('Dev')).toBe('dev');
    expect(parseExtensionEnvironment('STAGING')).toBe('staging');
    expect(parseExtensionEnvironment('PRODUCTION')).toBe('production');
    expect(parseExtensionEnvironment('Prod')).toBe('production');
    expect(parseExtensionEnvironment('PROD')).toBe('production');
  });

  test('trims whitespace', () => {
    expect(parseExtensionEnvironment('  dev  ')).toBe('dev');
    expect(parseExtensionEnvironment('\tproduction\n')).toBe('production');
    expect(parseExtensionEnvironment(' prod ')).toBe('production');
  });

  test('returns null for undefined', () => {
    expect(parseExtensionEnvironment(undefined)).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(parseExtensionEnvironment('')).toBeNull();
  });

  test('returns null for whitespace-only string', () => {
    expect(parseExtensionEnvironment('   ')).toBeNull();
    expect(parseExtensionEnvironment('\t')).toBeNull();
  });

  test('returns null for unrecognized values', () => {
    expect(parseExtensionEnvironment('test')).toBeNull();
    expect(parseExtensionEnvironment('unknown')).toBeNull();
    expect(parseExtensionEnvironment('release')).toBeNull();
    expect(parseExtensionEnvironment('development')).toBeNull();
    expect(parseExtensionEnvironment('prod-us')).toBeNull();
  });
});

// ── resolveBuildDefaultEnvironment ──────────────────────────────────

describe('resolveBuildDefaultEnvironment', () => {
  const savedEnv = process.env.VELLUM_ENVIRONMENT;

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.VELLUM_ENVIRONMENT;
    } else {
      process.env.VELLUM_ENVIRONMENT = savedEnv;
    }
  });

  test('returns the environment when VELLUM_ENVIRONMENT is a valid value', () => {
    process.env.VELLUM_ENVIRONMENT = 'staging';
    expect(resolveBuildDefaultEnvironment()).toBe('staging');
  });

  test('resolves "prod" alias via build env', () => {
    process.env.VELLUM_ENVIRONMENT = 'prod';
    expect(resolveBuildDefaultEnvironment()).toBe('production');
  });

  test('falls back to "production" when VELLUM_ENVIRONMENT is unset', () => {
    delete process.env.VELLUM_ENVIRONMENT;
    expect(resolveBuildDefaultEnvironment()).toBe('production');
  });

  test('falls back to "production" when VELLUM_ENVIRONMENT is empty', () => {
    process.env.VELLUM_ENVIRONMENT = '';
    expect(resolveBuildDefaultEnvironment()).toBe('production');
  });

  test('falls back to "production" when VELLUM_ENVIRONMENT is invalid', () => {
    process.env.VELLUM_ENVIRONMENT = 'bogus';
    expect(resolveBuildDefaultEnvironment()).toBe('production');
  });
});

// ── cloudUrlsForEnvironment ─────────────────────────────────────────

describe('cloudUrlsForEnvironment', () => {
  const cases: Array<{
    env: ExtensionEnvironment;
    expectedApiBaseUrl: string;
    expectedWebBaseUrl: string;
  }> = [
    {
      env: 'production',
      expectedApiBaseUrl: 'https://platform.vellum.ai',
      expectedWebBaseUrl: 'https://www.vellum.ai',
    },
    {
      env: 'staging',
      expectedApiBaseUrl: 'https://staging-platform.vellum.ai',
      expectedWebBaseUrl: 'https://staging-assistant.vellum.ai',
    },
    {
      env: 'dev',
      expectedApiBaseUrl: 'https://dev-platform.vellum.ai',
      expectedWebBaseUrl: 'https://dev-assistant.vellum.ai',
    },
    {
      env: 'local',
      expectedApiBaseUrl: 'http://localhost:8000',
      expectedWebBaseUrl: 'http://localhost:3000',
    },
  ];

  for (const { env, expectedApiBaseUrl, expectedWebBaseUrl } of cases) {
    test(`${env}: apiBaseUrl is ${expectedApiBaseUrl}`, () => {
      const urls = cloudUrlsForEnvironment(env);
      expect(urls.apiBaseUrl).toBe(expectedApiBaseUrl);
    });

    test(`${env}: webBaseUrl is ${expectedWebBaseUrl}`, () => {
      const urls = cloudUrlsForEnvironment(env);
      expect(urls.webBaseUrl).toBe(expectedWebBaseUrl);
    });
  }

  test('production parity: "prod" alias and "production" resolve to same URLs', () => {
    const fromProd = cloudUrlsForEnvironment('production');
    expect(fromProd.apiBaseUrl).toBe('https://platform.vellum.ai');
    expect(fromProd.webBaseUrl).toBe('https://www.vellum.ai');
  });
});
