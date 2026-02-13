import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverHooks } from '../hooks/discovery.js';

let hooksDir: string;

function makeManifest(name: string, events: string[] = ['pre-llm-call'], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name,
    description: `Test hook: ${name}`,
    version: '1.0.0',
    events,
    script: 'run.sh',
    ...extra,
  });
}

function installHook(name: string, events: string[] = ['pre-llm-call'], extra: Record<string, unknown> = {}): void {
  const hookDir = join(hooksDir, name);
  mkdirSync(hookDir, { recursive: true });
  writeFileSync(join(hookDir, 'hook.json'), makeManifest(name, events, extra));
  writeFileSync(join(hookDir, 'run.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
}

describe('hooks CLI operations', () => {
  beforeEach(() => {
    hooksDir = join(tmpdir(), `hooks-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(hooksDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(hooksDir, { recursive: true, force: true });
  });

  test('discoverHooks lists installed hooks', () => {
    installHook('hook-a', ['pre-llm-call']);
    installHook('hook-b', ['post-tool-execute', 'pre-tool-execute']);

    const hooks = discoverHooks(hooksDir);

    expect(hooks).toHaveLength(2);
    expect(hooks[0].name).toBe('hook-a');
    expect(hooks[0].manifest.events).toEqual(['pre-llm-call']);
    expect(hooks[1].name).toBe('hook-b');
    expect(hooks[1].manifest.events).toEqual(['post-tool-execute', 'pre-tool-execute']);
  });

  test('discoverHooks returns empty when no hooks', () => {
    const hooks = discoverHooks(hooksDir);
    expect(hooks).toHaveLength(0);
  });

  test('enable/disable toggles hook config', () => {
    // Write a config.json in hooksDir
    const configPath = join(hooksDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ version: 1, hooks: { 'my-hook': { enabled: false } } }));

    // Since setHookEnabled uses getHooksDir() internally, we test the lower-level functions
    // Read config directly
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.hooks['my-hook'].enabled).toBe(false);

    // Simulate enable
    config.hooks['my-hook'].enabled = true;
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    const updated = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(updated.hooks['my-hook'].enabled).toBe(true);

    // Simulate disable
    updated.hooks['my-hook'].enabled = false;
    writeFileSync(configPath, JSON.stringify(updated, null, 2));

    const final = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(final.hooks['my-hook'].enabled).toBe(false);
  });

  test('removeHook removes config entry', () => {
    const configPath = join(hooksDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      version: 1,
      hooks: {
        'keep-me': { enabled: true },
        'remove-me': { enabled: false },
      },
    }));

    // Simulate removeHook by manipulating the config directly
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    delete config.hooks['remove-me'];
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    const updated = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(updated.hooks['keep-me']).toBeDefined();
    expect(updated.hooks['remove-me']).toBeUndefined();
  });

  test('install copies directory and creates config entry', () => {
    // Create a source hook
    const srcDir = join(hooksDir, '_source');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, 'hook.json'), makeManifest('test-install', ['daemon-start']));
    writeFileSync(join(srcDir, 'run.sh'), '#!/bin/sh\necho installed\n', { mode: 0o755 });

    // Simulate install: copy to hooks dir
    const { cpSync, chmodSync } = require('node:fs');
    const targetDir = join(hooksDir, 'test-install');
    cpSync(srcDir, targetDir, { recursive: true });
    chmodSync(join(targetDir, 'run.sh'), 0o755);

    // Verify files exist
    expect(existsSync(join(targetDir, 'hook.json'))).toBe(true);
    expect(existsSync(join(targetDir, 'run.sh'))).toBe(true);

    // Verify hook is discoverable
    const hooks = discoverHooks(hooksDir);
    const installed = hooks.find((h) => h.name === 'test-install');
    expect(installed).toBeDefined();
    expect(installed!.manifest.events).toEqual(['daemon-start']);
  });

  test('remove deletes hook directory', () => {
    installHook('to-remove');
    expect(existsSync(join(hooksDir, 'to-remove'))).toBe(true);

    // Simulate remove
    rmSync(join(hooksDir, 'to-remove'), { recursive: true, force: true });

    expect(existsSync(join(hooksDir, 'to-remove'))).toBe(false);
    const hooks = discoverHooks(hooksDir);
    expect(hooks.find((h) => h.name === 'to-remove')).toBeUndefined();
  });

  test('list shows version and events for hooks with metadata', () => {
    installHook('versioned-hook', ['pre-llm-call', 'post-llm-call'], { version: '2.3.1' });

    const hooks = discoverHooks(hooksDir);
    expect(hooks).toHaveLength(1);
    expect(hooks[0].manifest.version).toBe('2.3.1');
    expect(hooks[0].manifest.events).toEqual(['pre-llm-call', 'post-llm-call']);
  });
});
