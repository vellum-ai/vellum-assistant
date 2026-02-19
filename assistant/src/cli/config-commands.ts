import type { Command } from 'commander';

import {
  loadRawConfig,
  saveRawConfig,
  getNestedValue,
  setNestedValue,
  API_KEY_PROVIDERS,
} from '../config/loader.js';
import {
  getAllRules,
  removeRule,
  clearAllRules,
} from '../permissions/trust-store.js';
import { getSecureKey, setSecureKey, deleteSecureKey } from '../security/secure-keys.js';
import { getCliLogger } from '../util/logger.js';
import { initializeDb } from '../memory/db.js';
import {
  getMemorySystemStatus,
  queryMemory,
  requestMemoryBackfill,
  requestMemoryCleanup,
  requestMemoryRebuildIndex,
} from '../memory/admin.js';
import { listConversations } from '../memory/conversation-store.js';

const log = getCliLogger('cli');

const SHORT_HASH_LENGTH = 8;

export function registerConfigCommand(program: Command): void {
  const config = program.command('config').description('Manage configuration');

  config
    .command('set <key> <value>')
    .description('Set a config value (supports dotted paths like apiKeys.anthropic)')
    .action((key: string, value: string) => {
      const raw = loadRawConfig();
      // Try to parse as JSON for booleans/numbers, fall back to string
      let parsed: unknown = value;
      try {
        parsed = JSON.parse(value);
      } catch {
        // keep as string
      }
      setNestedValue(raw, key, parsed);
      saveRawConfig(raw);
      log.info(`Set ${key} = ${JSON.stringify(parsed)}`);
    });

  config
    .command('get <key>')
    .description('Get a config value (supports dotted paths)')
    .action((key: string) => {
      const raw = loadRawConfig();
      const value = getNestedValue(raw, key);
      if (value === undefined) {
        log.info(`(not set)`);
      } else {
        log.info(typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value));
      }
    });

  config
    .command('list')
    .description('List all config values')
    .action(() => {
      const raw = loadRawConfig();
      if (Object.keys(raw).length === 0) {
        log.info('No configuration set');
      } else {
        log.info(JSON.stringify(raw, null, 2));
      }
    });

  config
    .command('validate-allowlist')
    .description('Validate regex patterns in secret-allowlist.json')
    .action(() => {
      const { validateAllowlistFile } = require('../security/secret-allowlist.js') as typeof import('../security/secret-allowlist.js');
      try {
        const errors = validateAllowlistFile();
        if (errors === null) {
          log.info('No secret-allowlist.json file found');
          return;
        }
        if (errors.length === 0) {
          log.info('All patterns in secret-allowlist.json are valid');
          return;
        }
        log.error(`Found ${errors.length} invalid pattern(s) in secret-allowlist.json:`);
        for (const e of errors) {
          log.error(`  [${e.index}] "${e.pattern}": ${e.message}`);
        }
        process.exit(1);
      } catch (err) {
        log.error(`Failed to read secret-allowlist.json: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}

export function registerKeysCommand(program: Command): void {
  const keys = program.command('keys').description('Manage API keys in secure storage');

  keys
    .command('list')
    .description('List all stored API key names')
    .action(() => {
      const stored: string[] = [];
      for (const provider of API_KEY_PROVIDERS) {
        const value = getSecureKey(provider);
        if (value) stored.push(provider);
      }
      if (stored.length === 0) {
        log.info('No API keys stored');
      } else {
        for (const name of stored) {
          log.info(`  ${name}`);
        }
      }
    });

  keys
    .command('set <provider> <key>')
    .description('Store an API key (e.g. vellum keys set anthropic sk-ant-...)')
    .action((provider: string, key: string) => {
      if (setSecureKey(provider, key)) {
        log.info(`Stored API key for "${provider}"`);
      } else {
        log.error(`Failed to store API key for "${provider}"`);
        process.exit(1);
      }
    });

  keys
    .command('delete <provider>')
    .description('Delete a stored API key')
    .action((provider: string) => {
      if (deleteSecureKey(provider)) {
        log.info(`Deleted API key for "${provider}"`);
      } else {
        log.error(`No API key found for "${provider}"`);
        process.exit(1);
      }
    });
}

export function registerTrustCommand(program: Command): void {
  const trust = program.command('trust').description('Manage trust rules');

  trust
    .command('list')
    .description('List all trust rules')
    .action(() => {
      const rules = getAllRules();
      if (rules.length === 0) {
        log.info('No trust rules');
        return;
      }
      const idW = 8;
      const toolW = 12;
      const patternW = 30;
      const scopeW = 20;
      const decW = 6;
      const priW = 4;
      log.info(
        'ID'.padEnd(idW) +
        'Tool'.padEnd(toolW) +
        'Pattern'.padEnd(patternW) +
        'Scope'.padEnd(scopeW) +
        'Dcn'.padEnd(decW) +
        'Pri'.padEnd(priW) +
        'Created',
      );
      log.info('-'.repeat(idW + toolW + patternW + scopeW + decW + priW + 20));
      for (const r of rules) {
        const id = r.id.slice(0, SHORT_HASH_LENGTH);
        const created = new Date(r.createdAt).toISOString().slice(0, 10);
        log.info(
          id.padEnd(idW) +
          r.tool.padEnd(toolW) +
          r.pattern.slice(0, patternW - 2).padEnd(patternW) +
          r.scope.slice(0, scopeW - 2).padEnd(scopeW) +
          r.decision.slice(0, decW - 1).padEnd(decW) +
          String(r.priority).padEnd(priW) +
          created,
        );
      }
    });

  trust
    .command('remove <id>')
    .description('Remove a trust rule by ID (or prefix)')
    .action((id: string) => {
      const rules = getAllRules();
      const match = rules.find((r) => r.id.startsWith(id));
      if (!match) {
        log.error(`No rule found matching "${id}"`);
        process.exit(1);
      }
      try {
        removeRule(match.id);
      } catch (err) {
        log.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      log.info(`Removed rule ${match.id.slice(0, SHORT_HASH_LENGTH)} (${match.tool}: ${match.pattern})`);
    });

  trust
    .command('clear')
    .description('Remove all trust rules')
    .action(async () => {
      const rules = getAllRules();
      if (rules.length === 0) {
        log.info('No trust rules to clear');
        return;
      }
      const readline = await import('node:readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolve) => {
        rl.question(`Remove all ${rules.length} trust rules? (y/N) `, resolve);
      });
      rl.close();
      if (answer.toLowerCase() === 'y') {
        clearAllRules();
        log.info(`Cleared ${rules.length} trust rules`);
      } else {
        log.info('Cancelled');
      }
    });
}

export function registerMemoryCommand(program: Command): void {
  const memory = program.command('memory').description('Manage long-term memory indexing/retrieval');

  memory
    .command('status')
    .description('Show memory subsystem status')
    .action(() => {
      initializeDb();
      const status = getMemorySystemStatus();
      log.info(`Memory enabled: ${status.enabled ? 'yes' : 'no'}`);
      log.info(`Memory degraded: ${status.degraded ? 'yes' : 'no'}`);
      if (status.reason) log.info(`Reason: ${status.reason}`);
      if (status.provider && status.model) {
        log.info(`Embedding backend: ${status.provider}/${status.model}`);
      } else {
        log.info('Embedding backend: none');
      }
      log.info(`Segments: ${status.counts.segments.toLocaleString()}`);
      log.info(`Items: ${status.counts.items.toLocaleString()}`);
      log.info(`Summaries: ${status.counts.summaries.toLocaleString()}`);
      log.info(`Embeddings: ${status.counts.embeddings.toLocaleString()}`);
      log.info(`Pending conflicts: ${status.conflicts.pending.toLocaleString()}`);
      log.info(`Resolved conflicts: ${status.conflicts.resolved.toLocaleString()}`);
      if (status.conflicts.oldestPendingAgeMs !== null) {
        const oldestMinutes = Math.floor(status.conflicts.oldestPendingAgeMs / 60_000);
        log.info(`Oldest pending conflict age: ${oldestMinutes} min`);
      } else {
        log.info('Oldest pending conflict age: n/a');
      }
      log.info(`Cleanup backlog (resolved conflicts): ${status.cleanup.resolvedBacklog.toLocaleString()}`);
      log.info(`Cleanup backlog (superseded items): ${status.cleanup.supersededBacklog.toLocaleString()}`);
      log.info(`Cleanup throughput 24h (resolved conflicts): ${status.cleanup.resolvedCompleted24h.toLocaleString()}`);
      log.info(`Cleanup throughput 24h (superseded items): ${status.cleanup.supersededCompleted24h.toLocaleString()}`);
      log.info('Jobs:');
      for (const [key, value] of Object.entries(status.jobs)) {
        log.info(`  ${key}: ${value}`);
      }
    });

  memory
    .command('backfill')
    .description('Queue a memory backfill job')
    .option('-f, --force', 'Restart backfill from the beginning')
    .action((opts: { force?: boolean }) => {
      initializeDb();
      const jobId = requestMemoryBackfill(Boolean(opts?.force));
      log.info(`Queued backfill job: ${jobId}`);
    });

  memory
    .command('cleanup')
    .description('Queue cleanup jobs for resolved conflicts and stale superseded items')
    .option('--retention-ms <ms>', 'Optional retention threshold in milliseconds')
    .action((opts: { retentionMs?: string }) => {
      initializeDb();
      const retentionMs = opts.retentionMs ? Number.parseInt(opts.retentionMs, 10) : undefined;
      const jobs = requestMemoryCleanup(Number.isFinite(retentionMs) ? retentionMs : undefined);
      log.info(`Queued cleanup_resolved_conflicts job: ${jobs.resolvedConflictsJobId}`);
      log.info(`Queued cleanup_stale_superseded_items job: ${jobs.staleSupersededItemsJobId}`);
    });

  memory
    .command('query <text>')
    .description('Run a memory recall query and print the injected memory payload')
    .option('-s, --session <id>', 'Optional conversation/session ID')
    .action(async (text: string, opts?: { session?: string }) => {
      initializeDb();
      let sessionId = opts?.session;
      if (!sessionId) {
        const latest = listConversations(1)[0];
        sessionId = latest?.id ?? '';
      }
      const result = await queryMemory(text, sessionId ?? '');
      if (result.degraded) {
        log.info(`Memory degraded: ${result.reason ?? 'unknown reason'}`);
      }
      log.info(`Lexical hits: ${result.lexicalHits}`);
      log.info(`Semantic hits: ${result.semanticHits}`);
      log.info(`Recency hits: ${result.recencyHits}`);
      log.info(`Entity hits: ${result.entityHits}`);
      log.info(`Injected tokens: ${result.injectedTokens}`);
      log.info(`Latency: ${result.latencyMs}ms`);
      if (result.injectedText.length > 0) {
        log.info('');
        log.info(result.injectedText);
      } else {
        log.info('No memory injected.');
      }
    });

  memory
    .command('rebuild-index')
    .description('Queue a memory FTS+embedding index rebuild job')
    .action(() => {
      initializeDb();
      const jobId = requestMemoryRebuildIndex();
      log.info(`Queued rebuild-index job: ${jobId}`);
    });
}
