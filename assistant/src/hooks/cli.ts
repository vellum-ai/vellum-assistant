import { Command } from 'commander';
import { cpSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { pathExists } from '../util/fs.js';
import { join, resolve, sep } from 'node:path';
import { discoverHooks, isValidInstallManifest } from './discovery.js';
import { setHookEnabled, ensureHookInConfig, removeHook } from './config.js';
import { getCliLogger } from '../util/logger.js';
import { getHooksDir } from '../util/platform.js';

const log = getCliLogger('hooks');

export function registerHooksCommand(program: Command): void {
  const hooks = program.command('hooks').description('Manage hooks');

  hooks
    .command('list')
    .description('List all installed hooks')
    .action(() => {
      const discovered = discoverHooks();
      if (discovered.length === 0) {
        log.info('No hooks installed');
        return;
      }

      const nameW = 24;
      const eventsW = 24;
      const enabledW = 10;
      log.info(
        'Name'.padEnd(nameW) +
        'Events'.padEnd(eventsW) +
        'Enabled'.padEnd(enabledW) +
        'Version',
      );
      log.info('-'.repeat(nameW + eventsW + enabledW + 10));

      for (const hook of discovered) {
        const events = hook.manifest.events.join(', ');
        const eventsTrunc = events.length > eventsW - 2
          ? events.slice(0, eventsW - 4) + '..'
          : events;
        log.info(
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
        log.error(`Hook not found: ${name}`);
        process.exit(1);
      }
      setHookEnabled(name, true);
      log.info(`Enabled hook: ${name}`);
    });

  hooks
    .command('disable <name>')
    .description('Disable a hook')
    .action((name: string) => {
      const discovered = discoverHooks();
      const hook = discovered.find((h) => h.name === name);
      if (!hook) {
        log.error(`Hook not found: ${name}`);
        process.exit(1);
      }
      setHookEnabled(name, false);
      log.info(`Disabled hook: ${name}`);
    });

  hooks
    .command('install <path>')
    .description('Install a hook from a directory')
    .action((hookPath: string) => {
      const srcDir = resolve(hookPath);
      if (!pathExists(srcDir)) {
        log.error(`Directory not found: ${srcDir}`);
        process.exit(1);
      }

      const manifestPath = join(srcDir, 'hook.json');
      if (!pathExists(manifestPath)) {
        log.error(`No hook.json found in ${srcDir}`);
        process.exit(1);
      }

      let manifest: unknown;
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      } catch {
        log.error(`Failed to parse hook.json in ${srcDir}`);
        process.exit(1);
      }

      if (!isValidInstallManifest(manifest)) {
        log.error('Invalid hook.json: must have a non-empty name, script, description (string), version (string), and at least one valid event');
        process.exit(1);
      }

      const hooksDir = getHooksDir();
      const resolvedHooksDir = resolve(hooksDir);
      const targetDir = resolve(join(hooksDir, manifest.name));
      if (!targetDir.startsWith(resolvedHooksDir + sep)) {
        log.error(`Invalid hook name: "${manifest.name}" would escape the hooks directory`);
        process.exit(1);
      }

      const scriptPath = resolve(join(targetDir, manifest.script));
      if (!scriptPath.startsWith(targetDir + sep)) {
        log.error(`Invalid hook script: "${manifest.script}" would escape the hook directory`);
        process.exit(1);
      }

      if (pathExists(targetDir)) {
        log.error(`Hook already installed: ${manifest.name}`);
        process.exit(1);
      }

      cpSync(srcDir, targetDir, { recursive: true });

      // Make script executable
      if (pathExists(scriptPath)) {
        chmodSync(scriptPath, 0o755);
      }

      ensureHookInConfig(manifest.name, { enabled: false });
      log.info(`Installed hook: ${manifest.name} (disabled by default)`);
    });

  hooks
    .command('remove <name>')
    .description('Remove an installed hook')
    .action(async (name: string) => {
      const discovered = discoverHooks();
      const hook = discovered.find((h) => h.name === name);
      if (!hook) {
        log.error(`Hook not found: ${name}`);
        process.exit(1);
      }

      const readline = await import('node:readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolve) => {
        rl.question(`Remove hook "${name}" and delete its files? (y/N) `, resolve);
      });
      rl.close();

      if (answer.toLowerCase() !== 'y') {
        log.info('Cancelled');
        return;
      }

      rmSync(hook.dir, { recursive: true, force: true });
      removeHook(name);
      log.info(`Removed hook: ${name}`);
    });
}
