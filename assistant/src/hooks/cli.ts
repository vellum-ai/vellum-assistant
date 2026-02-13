import { Command } from 'commander';
import { existsSync, cpSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { discoverHooks } from './discovery.js';
import { setHookEnabled, ensureHookInConfig, removeHook } from './config.js';
import { getHooksDir } from '../util/platform.js';
import type { HookManifest } from './types.js';

export function registerHooksCommand(program: Command): void {
  const hooks = program.command('hooks').description('Manage hooks');

  hooks
    .command('list')
    .description('List all installed hooks')
    .action(() => {
      const discovered = discoverHooks();
      if (discovered.length === 0) {
        console.log('No hooks installed');
        return;
      }

      const nameW = 24;
      const eventsW = 24;
      const enabledW = 10;
      console.log(
        'Name'.padEnd(nameW) +
        'Events'.padEnd(eventsW) +
        'Enabled'.padEnd(enabledW) +
        'Version',
      );
      console.log('-'.repeat(nameW + eventsW + enabledW + 10));

      for (const hook of discovered) {
        const events = hook.manifest.events.join(', ');
        const eventsTrunc = events.length > eventsW - 2
          ? events.slice(0, eventsW - 4) + '..'
          : events;
        console.log(
          hook.name.slice(0, nameW - 2).padEnd(nameW) +
          eventsTrunc.padEnd(eventsW) +
          (hook.enabled ? 'yes' : 'no').padEnd(enabledW) +
          (hook.manifest.version ?? '-'),
        );
      }
    });

  hooks
    .command('enable <name>')
    .description('Enable a hook')
    .action((name: string) => {
      const discovered = discoverHooks();
      const hook = discovered.find((h) => h.name === name);
      if (!hook) {
        console.error(`Hook not found: ${name}`);
        process.exit(1);
      }
      setHookEnabled(name, true);
      console.log(`Enabled hook: ${name}`);
    });

  hooks
    .command('disable <name>')
    .description('Disable a hook')
    .action((name: string) => {
      const discovered = discoverHooks();
      const hook = discovered.find((h) => h.name === name);
      if (!hook) {
        console.error(`Hook not found: ${name}`);
        process.exit(1);
      }
      setHookEnabled(name, false);
      console.log(`Disabled hook: ${name}`);
    });

  hooks
    .command('install <path>')
    .description('Install a hook from a directory')
    .action((hookPath: string) => {
      const srcDir = resolve(hookPath);
      if (!existsSync(srcDir)) {
        console.error(`Directory not found: ${srcDir}`);
        process.exit(1);
      }

      const manifestPath = join(srcDir, 'hook.json');
      if (!existsSync(manifestPath)) {
        console.error(`No hook.json found in ${srcDir}`);
        process.exit(1);
      }

      let manifest: HookManifest;
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as HookManifest;
      } catch {
        console.error(`Failed to parse hook.json in ${srcDir}`);
        process.exit(1);
      }

      if (!manifest.name || !manifest.script || !Array.isArray(manifest.events)) {
        console.error('Invalid hook.json: missing required fields (name, script, events)');
        process.exit(1);
      }

      const hooksDir = getHooksDir();
      const targetDir = join(hooksDir, manifest.name);
      if (existsSync(targetDir)) {
        console.error(`Hook already installed: ${manifest.name}`);
        process.exit(1);
      }

      cpSync(srcDir, targetDir, { recursive: true });

      // Make script executable
      const scriptPath = join(targetDir, manifest.script);
      if (existsSync(scriptPath)) {
        chmodSync(scriptPath, 0o755);
      }

      ensureHookInConfig(manifest.name, { enabled: false });
      console.log(`Installed hook: ${manifest.name} (disabled by default)`);
    });

  hooks
    .command('remove <name>')
    .description('Remove an installed hook')
    .action(async (name: string) => {
      const discovered = discoverHooks();
      const hook = discovered.find((h) => h.name === name);
      if (!hook) {
        console.error(`Hook not found: ${name}`);
        process.exit(1);
      }

      const readline = await import('node:readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolve) => {
        rl.question(`Remove hook "${name}" and delete its files? (y/N) `, resolve);
      });
      rl.close();

      if (answer.toLowerCase() !== 'y') {
        console.log('Cancelled');
        return;
      }

      rmSync(hook.dir, { recursive: true, force: true });
      removeHook(name);
      console.log(`Removed hook: ${name}`);
    });
}
