#!/usr/bin/env bun

import { Command } from 'commander';
import { createRequire } from 'node:module';
import * as net from 'node:net';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };
import {
  ensureDaemonRunning,
  startDaemon,
  stopDaemon,
  getDaemonStatus,
} from './daemon/lifecycle.js';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { execSync, spawn } from 'node:child_process';
import { startCli } from './cli.js';
import { getSocketPath, readSessionToken, getRootDir, getDataDir, getDbPath, getLogPath, getWorkspaceDir, getWorkspaceSkillsDir, getWorkspaceHooksDir } from './util/platform.js';
import {
  serialize,
  createMessageParser,
  type ClientMessage,
  type ServerMessage,
} from './daemon/ipc-protocol.js';
import { IpcError } from './util/errors.js';
import { getCliLogger } from './util/logger.js';
import { timeAgo } from './util/time.js';
import { shouldAutoStartDaemon, hasSocketOverride } from './daemon/connection-policy.js';
import {
  loadRawConfig,
  saveRawConfig,
  getNestedValue,
  setNestedValue,
  getConfig,
  API_KEY_PROVIDERS,
} from './config/loader.js';
import {
  getAllRules,
  removeRule,
  clearAllRules,
} from './permissions/trust-store.js';
import { getSecureKey, setSecureKey, deleteSecureKey } from './security/secure-keys.js';
import { getRecentInvocations } from './memory/tool-usage-store.js';
import {
  getConversation,
  getMessages,
  listConversations,
  clearAll as clearAllConversations,
} from './memory/conversation-store.js';
import { initializeDb } from './memory/db.js';
import { initQdrantClient } from './memory/qdrant-client.js';
import { formatMarkdown, formatJson } from './export/formatter.js';
import {
  getMemorySystemStatus,
  queryMemory,
  requestMemoryBackfill,
  requestMemoryCleanup,
  requestMemoryRebuildIndex,
} from './memory/admin.js';
import { registerHooksCommand } from './hooks/cli.js';
import { registerEmailCommand } from './cli/email.js';
import { registerContactsCommand } from './cli/contacts.js';
import { registerAutonomyCommand } from './cli/autonomy.js';
import { registerDoordashCommand } from './cli/doordash.js';

function sendOneMessage(
  msg: ClientMessage,
): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(getSocketPath());
    const parser = createMessageParser();
    let resolved = false;
    let authenticated = false;

    socket.on('connect', () => {
      // Authenticate first — the daemon requires a valid session token
      // before it will accept any other messages.
      const token = readSessionToken();
      if (!token) {
        resolved = true;
        reject(new IpcError('Session token not found — is the daemon running?'));
        socket.destroy();
        return;
      }
      socket.write(serialize({ type: 'auth', token }));
    });

    socket.on('data', (data) => {
      const messages = parser.feed(data.toString()) as ServerMessage[];
      for (const m of messages) {
        // Handle auth handshake
        if (!authenticated) {
          if (m.type === 'auth_result') {
            if ((m as { success: boolean }).success) {
              authenticated = true;
              // Now send the actual message
              socket.write(serialize(msg));
            } else {
              resolved = true;
              reject(new IpcError((m as { message?: string }).message ?? 'Authentication failed'));
              socket.destroy();
            }
          }
          continue;
        }

        // Skip push messages that aren't responses to our request
        if (m.type === 'daemon_status') {
          continue;
        }
        // On auto-auth sockets the server may send a second auth_result
        // in response to the client's auth message after we're already
        // authenticated — ignore it so it doesn't resolve as the response.
        if (m.type === 'auth_result') {
          continue;
        }
        if (m.type === 'session_info' && msg.type !== 'session_create') {
          continue;
        }
        resolved = true;
        socket.end();
        resolve(m);
        return;
      }
    });

    socket.on('error', (err) => {
      if (!resolved) reject(err);
    });

    socket.on('close', () => {
      if (!resolved) {
        reject(new IpcError('Socket closed before receiving a response'));
      }
    });
  });
}

const log = getCliLogger('cli');

const program = new Command();

program
  .name('vellum')
  .description('Local AI assistant')
  .version(version)
  .action(async () => {
    if (shouldAutoStartDaemon()) {
      await ensureDaemonRunning();
    }
    await startCli();
  });

const daemon = program.command('daemon').description('Manage the daemon process');

daemon
  .command('start')
  .description('Start the daemon')
  .action(async () => {
    const result = await startDaemon();
    if (result.alreadyRunning) {
      log.info(`Daemon already running (pid ${result.pid})`);
    } else {
      log.info(`Daemon started (pid ${result.pid})`);
    }
  });

daemon
  .command('stop')
  .description('Stop the daemon')
  .action(async () => {
    const result = await stopDaemon();
    if (result.stopped) {
      log.info('Daemon stopped');
    } else if (result.reason === 'stop_failed') {
      log.error('Failed to stop daemon — process survived SIGKILL');
      process.exit(1);
    } else {
      log.info('Daemon is not running');
    }
  });

daemon
  .command('restart')
  .description('Restart the daemon')
  .action(async () => {
    const stopResult = await stopDaemon();
    if (stopResult.stopped) {
      log.info('Daemon stopped');
    } else if (stopResult.reason === 'stop_failed') {
      log.error('Failed to stop daemon — process survived SIGKILL, cannot restart');
      process.exit(1);
    }
    const startResult = await startDaemon();
    log.info(`Daemon started (pid ${startResult.pid})`);
  });

daemon
  .command('status')
  .description('Show daemon status')
  .action(() => {
    const status = getDaemonStatus();
    if (status.running) {
      log.info(`Daemon is running (pid ${status.pid})`);
    } else {
      log.info('Daemon is not running');
    }
    log.info(`Socket path: ${getSocketPath()}${hasSocketOverride() ? ' (override)' : ''}`);
    log.info(`Autostart: ${shouldAutoStartDaemon() ? 'enabled' : 'disabled'}`);
  });

// --- Dev command ---
program
  .command('dev')
  .description('Run the daemon in dev mode with auto-restart on file changes')
  .action(async () => {
    // Stop any existing daemon first
    const status = getDaemonStatus();
    if (status.running) {
      log.info('Stopping existing daemon...');
      const stopResult = await stopDaemon();
      if (!stopResult.stopped && stopResult.reason === 'stop_failed') {
        log.error('Failed to stop existing daemon — process survived SIGKILL');
        process.exit(1);
      }
    }

    const mainPath = `${import.meta.dirname}/daemon/main.ts`;

    log.info('Starting daemon in dev mode (Ctrl+C to stop)');

    const child = spawn('bun', ['--watch', 'run', mainPath], {
      stdio: 'inherit',
      env: {
        ...process.env,
        VELLUM_LOG_STDERR: '1',
        VELLUM_DEBUG: '1',
      },
    });

    const forward = (signal: NodeJS.Signals) => {
      child.kill(signal);
    };
    process.on('SIGINT', () => forward('SIGINT'));
    process.on('SIGTERM', () => forward('SIGTERM'));

    child.on('exit', (code) => {
      process.exit(code ?? 0);
    });
  });

const sessions = program.command('sessions').description('Manage sessions');

sessions
  .command('list')
  .description('List all sessions')
  .action(async () => {
    if (shouldAutoStartDaemon()) await ensureDaemonRunning();
    const response = await sendOneMessage({ type: 'session_list' });
    if (response.type === 'session_list_response') {
      if (response.sessions.length === 0) {
        log.info('No sessions');
      } else {
        for (const s of response.sessions) {
          log.info(`  ${s.id}  ${s.title}  ${timeAgo(s.updatedAt)}`);
        }
      }
    } else if (response.type === 'error') {
      log.error(`Error: ${response.message}`);
    }
  });

sessions
  .command('new [title]')
  .description('Create a new session')
  .action(async (title?: string) => {
    if (shouldAutoStartDaemon()) await ensureDaemonRunning();
    const response = await sendOneMessage({
      type: 'session_create',
      title,
    });
    if (response.type === 'session_info') {
      log.info(`Created session: ${response.title} (${response.sessionId})`);
    } else if (response.type === 'error') {
      log.error(`Error: ${response.message}`);
    }
  });

sessions
  .command('export [sessionId]')
  .description('Export a conversation as markdown or JSON')
  .option('-f, --format <format>', 'Output format: md or json', 'md')
  .option('-o, --output <file>', 'Write to file instead of stdout')
  .action(async (sessionId?: string, opts?: { format: string; output?: string }) => {
    initializeDb();
    const format = opts?.format ?? 'md';
    if (format !== 'md' && format !== 'json') {
      log.error('Error: format must be "md" or "json"');
      process.exit(1);
    }

    // If no session ID given, pick the most recent one
    let id = sessionId;
    if (!id) {
      const all = listConversations(1);
      if (all.length === 0) {
        log.error('No sessions found');
        process.exit(1);
      }
      id = all[0].id;
    }

    // Support prefix matching for session IDs
    let conversation = getConversation(id);
    if (!conversation) {
      const all = listConversations(Number.MAX_SAFE_INTEGER);
      const match = all.find((c) => c.id.startsWith(id!));
      if (match) {
        conversation = match;
      } else {
        log.error(`Session not found: ${id}`);
        process.exit(1);
      }
    }

    const msgs = getMessages(conversation.id);
    const exportData = {
      ...conversation,
      messages: msgs.map((m) => ({
        role: m.role,
        content: JSON.parse(m.content),
        createdAt: m.createdAt,
      })),
    };

    const output = format === 'json'
      ? formatJson(exportData)
      : formatMarkdown(exportData);

    if (opts?.output) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(opts.output, output);
      log.info(`Exported to ${opts.output}`);
    } else {
      process.stdout.write(output);
    }
  });

sessions
  .command('clear')
  .description('Clear all conversations, messages, and vector data (dev only)')
  .action(async () => {
    log.info('This will permanently delete all conversations, messages, and vector data.');

    const readline = await import('node:readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question('Are you sure? (y/N) ', resolve);
    });
    rl.close();
    if (answer.toLowerCase() !== 'y') {
      log.info('Cancelled');
      return;
    }

    initializeDb();
    const result = clearAllConversations();
    log.info(`Cleared ${result.conversations} conversations, ${result.messages} messages`);

    // Notify a running daemon to drop its in-memory sessions so it
    // doesn't keep serving stale history from deleted conversation rows.
    try {
      await sendOneMessage({ type: 'sessions_clear' });
    } catch {
      // Daemon may not be running — that's fine, no sessions to invalidate.
    }

    const config = getConfig();
    const qdrantUrl = process.env.QDRANT_URL?.trim() || config.memory.qdrant.url;
    const qdrant = initQdrantClient({
      url: qdrantUrl,
      collection: config.memory.qdrant.collection,
      vectorSize: config.memory.qdrant.vectorSize,
      onDisk: config.memory.qdrant.onDisk,
      quantization: config.memory.qdrant.quantization,
    });
    const deleted = await qdrant.deleteCollection();
    if (deleted) {
      log.info(`Deleted Qdrant collection "${config.memory.qdrant.collection}"`);
    } else {
      log.info('Qdrant collection not found or not reachable (skipped)');
    }

    log.info('Done.');
  });

// --- Config commands ---
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

// --- Keys commands ---
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

// --- Trust commands ---
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
    // Table header
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
      const id = r.id.slice(0, 8);
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
    // Support prefix matching
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
    log.info(`Removed rule ${match.id.slice(0, 8)} (${match.tool}: ${match.pattern})`);
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
    // Confirmation prompt
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

// --- Memory commands ---
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

// --- Audit command ---
program
  .command('audit')
  .description('Show recent tool invocations')
  .option('-l, --limit <n>', 'Number of entries to show', '20')
  .action((opts: { limit: string }) => {
    const limit = parseInt(opts.limit, 10) || 20;
    const rows = getRecentInvocations(limit);
    if (rows.length === 0) {
      log.info('No tool invocations recorded');
      return;
    }
    const tsW = 20;
    const toolW = 14;
    const inputW = 30;
    const decW = 8;
    const riskW = 8;
    const durW = 8;
    log.info(
      'Timestamp'.padEnd(tsW) +
      'Tool'.padEnd(toolW) +
      'Input'.padEnd(inputW) +
      'Decision'.padEnd(decW) +
      'Risk'.padEnd(riskW) +
      'Duration',
    );
    log.info('-'.repeat(tsW + toolW + inputW + decW + riskW + durW));
    for (const r of rows) {
      const ts = new Date(r.createdAt).toISOString().slice(0, 19).replace('T', ' ');
      // Summarize input: take first meaningful chunk
      let inputSummary = '';
      try {
        const parsed = JSON.parse(r.input);
        if (parsed.command) inputSummary = parsed.command;
        else if (parsed.path) inputSummary = parsed.path;
        else inputSummary = r.input;
      } catch {
        inputSummary = r.input;
      }
      if (inputSummary.length > inputW - 2) {
        inputSummary = inputSummary.slice(0, inputW - 4) + '..';
      }
      const dur = r.durationMs < 1000 ? `${r.durationMs}ms` : `${(r.durationMs / 1000).toFixed(1)}s`;
      log.info(
        ts.padEnd(tsW) +
        r.toolName.padEnd(toolW) +
        inputSummary.padEnd(inputW) +
        r.decision.padEnd(decW) +
        r.riskLevel.padEnd(riskW) +
        dur,
      );
    }
  });

// --- Doctor command ---
program
  .command('doctor')
  .description('Run diagnostic checks')
  .action(async () => {
    const pass = (label: string) => log.info(`  \u2713 ${label}`);
    const fail = (label: string, detail?: string) =>
      log.info(`  \u2717 ${label}${detail ? ` — ${detail}` : ''}`);

    log.info('Vellum Doctor\n');

    // 0. Connection policy info
    const socketPath = getSocketPath();
    const isOverride = hasSocketOverride();
    const autostart = shouldAutoStartDaemon();
    log.info(`  Socket:    ${socketPath}${isOverride ? ' (override via VELLUM_DAEMON_SOCKET)' : ''}`);
    log.info(`  Autostart: ${autostart ? 'enabled' : 'disabled'}\n`);

    // 1. Bun installed
    try {
      execSync('bun --version', { stdio: 'pipe' });
      pass('Bun is installed');
    } catch {
      fail('Bun is installed', 'bun not found in PATH');
    }

    // 2. Provider/API key configured
    const raw = loadRawConfig();
    const provider = typeof raw.provider === 'string' ? raw.provider : 'anthropic';
    const providerEnvVar: Record<string, string> = {
      anthropic: 'ANTHROPIC_API_KEY',
      openai: 'OPENAI_API_KEY',
      gemini: 'GEMINI_API_KEY',
      ollama: 'OLLAMA_API_KEY',
      fireworks: 'FIREWORKS_API_KEY',
    };
    const configKey = (raw.apiKeys as Record<string, string> | undefined)?.[provider];
    const envVar = providerEnvVar[provider];
    const envKey = envVar ? process.env[envVar] : undefined;

    if (provider === 'ollama') {
      pass('Provider configured (Ollama; API key optional)');
    } else if (envKey || configKey) {
      pass('API key configured');
    } else {
      fail(
        'API key configured',
        envVar
          ? `set ${envVar} or run: vellum config set apiKeys.${provider} <key>`
          : `set API key for provider "${provider}"`,
      );
    }

    // 3. Daemon reachable
    try {
      const sock = getSocketPath();
      if (!existsSync(sock)) {
        fail('Daemon reachable', 'socket not found (is the daemon running?)');
      } else {
        await new Promise<void>((resolve, reject) => {
          const s = net.createConnection(sock);
          const timer = setTimeout(() => { s.destroy(); reject(new IpcError('timeout')); }, 2000);
          s.on('connect', () => { clearTimeout(timer); s.end(); resolve(); });
          s.on('error', (err) => { clearTimeout(timer); reject(err); });
        });
        pass('Daemon reachable');
      }
    } catch {
      fail('Daemon reachable', 'could not connect to daemon socket');
    }

    // 4. DB exists and readable
    const dbPath = getDbPath();
    if (existsSync(dbPath)) {
      try {
        const { Database } = await import('bun:sqlite');
        const db = new Database(dbPath, { readonly: true });
        db.query('SELECT 1').get();
        db.close();
        pass('Database exists and readable');
      } catch {
        fail('Database exists and readable', 'file exists but cannot be read');
      }
    } else {
      fail('Database exists and readable', `not found at ${dbPath}`);
    }

    // 5. ~/.vellum/ directory structure (workspace layout)
    const rootDir = getRootDir();
    const dataDir = getDataDir();
    const workspaceDir = getWorkspaceDir();
    const requiredDirs = [rootDir, workspaceDir, dataDir, `${dataDir}/db`, `${dataDir}/logs`, getWorkspaceSkillsDir(), getWorkspaceHooksDir(), `${rootDir}/protected`];
    const missing = requiredDirs.filter((d) => !existsSync(d));
    if (missing.length === 0) {
      pass('Directory structure exists');
    } else {
      fail('Directory structure exists', `missing: ${missing.join(', ')}`);
    }

    // 6. Disk space
    try {
      const output = execSync(`df -k "${rootDir}"`, { stdio: 'pipe', encoding: 'utf-8' });
      const lines = output.trim().split('\n');
      if (lines.length >= 2) {
        const cols = lines[1].trim().split(/\s+/);
        // df -k output: Filesystem 1K-blocks Used Available ...
        const availKB = parseInt(cols[3], 10);
        if (isNaN(availKB)) {
          fail('Disk space', 'could not parse available space');
        } else if (availKB < 100 * 1024) {
          fail('Disk space', `only ${Math.round(availKB / 1024)}MB free (< 100MB)`);
        } else {
          pass(`Disk space (${Math.round(availKB / 1024)}MB free)`);
        }
      } else {
        fail('Disk space', 'unexpected df output');
      }
    } catch {
      fail('Disk space', 'could not check disk space');
    }

    // 7. Log file size
    const logPath = getLogPath();
    if (existsSync(logPath)) {
      try {
        const logStat = statSync(logPath);
        const logSizeMB = logStat.size / (1024 * 1024);
        if (logSizeMB > 50) {
          fail('Log file size', `${logSizeMB.toFixed(1)}MB (> 50MB)`);
        } else {
          pass(`Log file size (${logSizeMB.toFixed(1)}MB)`);
        }
      } catch {
        fail('Log file size', 'could not stat log file');
      }
    } else {
      pass('Log file size (no log file yet)');
    }

    // 8. DB integrity check
    if (existsSync(dbPath)) {
      try {
        const { Database } = await import('bun:sqlite');
        const db = new Database(dbPath, { readonly: true });
        const result = db.query('PRAGMA integrity_check').get() as { integrity_check: string } | null;
        db.close();
        if (result?.integrity_check === 'ok') {
          pass('Database integrity check');
        } else {
          fail('Database integrity check', result?.integrity_check ?? 'unknown result');
        }
      } catch (err) {
        fail('Database integrity check', err instanceof Error ? err.message : 'unknown error');
      }
    } else {
      fail('Database integrity check', 'database file not found');
    }

    // 9. Socket permissions
    const sockPath = getSocketPath();
    if (existsSync(sockPath)) {
      try {
        const sockStat = statSync(sockPath);
        const mode = sockStat.mode & 0o777;
        if (mode === 0o600 || mode === 0o700) {
          pass(`Socket permissions (${mode.toString(8).padStart(4, '0')})`);
        } else {
          fail('Socket permissions', `expected 0600 or 0700, got 0${mode.toString(8)}`);
        }
      } catch {
        fail('Socket permissions', 'could not stat socket');
      }
    } else {
      pass('Socket permissions (socket not present — daemon not running)');
    }

    // 10. Trust rule syntax
    const trustPath = `${rootDir}/protected/trust.json`;
    if (existsSync(trustPath)) {
      try {
        const raw = readFileSync(trustPath, 'utf-8');
        const data = JSON.parse(raw);
        if (typeof data !== 'object' || data === null) {
          fail('Trust rule syntax', 'trust.json is not a JSON object');
        } else if (typeof data.version !== 'number') {
          fail('Trust rule syntax', 'missing or invalid "version" field');
        } else if (!Array.isArray(data.rules)) {
          fail('Trust rule syntax', 'missing or invalid "rules" array');
        } else {
          const invalid = data.rules.filter(
            (r: unknown) =>
              typeof r !== 'object' || r === null ||
              typeof (r as Record<string, unknown>).tool !== 'string' ||
              typeof (r as Record<string, unknown>).pattern !== 'string' ||
              typeof (r as Record<string, unknown>).scope !== 'string',
          );
          if (invalid.length > 0) {
            fail('Trust rule syntax', `${invalid.length} rule(s) have invalid structure`);
          } else {
            pass(`Trust rule syntax (${data.rules.length} rule(s))`);
          }
        }
      } catch (err) {
        fail('Trust rule syntax', err instanceof Error ? err.message : 'could not parse');
      }
    } else {
      pass('Trust rule syntax (no trust.json yet)');
    }

    // 11. WASM files
    const wasmFiles = [
      'node_modules/web-tree-sitter/web-tree-sitter.wasm',
      'node_modules/tree-sitter-bash/tree-sitter-bash.wasm',
    ];
    let wasmOk = true;
    const missingWasm: string[] = [];
    for (const wasm of wasmFiles) {
      // Resolve relative to the assistant package directory
      const fullPath = `${import.meta.dirname}/../${wasm}`;
      if (!existsSync(fullPath)) {
        missingWasm.push(wasm);
        wasmOk = false;
      } else {
        try {
          const wasmStat = statSync(fullPath);
          if (wasmStat.size === 0) {
            missingWasm.push(`${wasm} (empty)`);
            wasmOk = false;
          }
        } catch {
          missingWasm.push(`${wasm} (unreadable)`);
          wasmOk = false;
        }
      }
    }
    if (wasmOk) {
      pass('WASM files present and non-empty');
    } else {
      fail('WASM files', missingWasm.join(', '));
    }

    // 12. Browser runtime (Playwright + Chromium)
    const { checkBrowserRuntime } = await import('./tools/browser/runtime-check.js');
    const browserStatus = await checkBrowserRuntime();
    if (browserStatus.playwrightAvailable && browserStatus.chromiumInstalled) {
      pass('Browser runtime (Playwright + Chromium)');
    } else if (!browserStatus.playwrightAvailable) {
      fail('Browser runtime', 'playwright not available');
    } else {
      fail('Browser runtime', browserStatus.error ?? 'Chromium not installed');
    }

    // 13. Sandbox backend diagnostics
    const { runSandboxDiagnostics } = await import('./tools/terminal/sandbox-diagnostics.js');
    const sandbox = runSandboxDiagnostics();
    log.info(`\n  Sandbox:   ${sandbox.config.enabled ? 'enabled' : 'disabled'}`);
    log.info(`  Backend:   ${sandbox.config.backend}`);
    log.info(`  Reason:    ${sandbox.activeBackendReason}`);
    if (sandbox.config.backend === 'docker') {
      log.info(`  Image:     ${sandbox.config.dockerImage}`);
    }
    log.info('');
    for (const check of sandbox.checks) {
      if (check.ok) {
        pass(check.label);
      } else {
        fail(check.label, check.detail);
      }
    }
  });

// --- Hooks commands ---
registerHooksCommand(program);

// --- Email commands ---
registerEmailCommand(program);

// --- Contacts commands ---
registerContactsCommand(program);

// --- Autonomy commands ---
registerAutonomyCommand(program);

// --- DoorDash commands ---
registerDoordashCommand(program);

// --- Completions command ---
program
  .command('completions')
  .argument('<shell>', 'Shell type: bash, zsh, or fish')
  .description('Generate shell completion script (e.g. vellum completions bash >> ~/.bashrc)')
  .action((shell: string) => {
    const subcommands: Record<string, string[]> = {
      daemon: ['start', 'stop', 'restart', 'status'],
      sessions: ['list', 'new', 'export', 'clear'],
      config: ['set', 'get', 'list'],
      keys: ['list', 'set', 'delete'],
      trust: ['list', 'remove', 'clear'],
      memory: ['status', 'backfill', 'query', 'rebuild-index'],
      hooks: ['list', 'enable', 'disable', 'install', 'remove'],
      contacts: ['list', 'get', 'merge'],
      autonomy: ['get', 'set'],
    };
    const topLevel = [
      'daemon', 'dev', 'sessions', 'config', 'keys', 'trust', 'memory',
      'hooks', 'contacts', 'autonomy', 'audit', 'doctor', 'completions', 'help',
    ];

    switch (shell) {
      case 'bash':
        process.stdout.write(generateBashCompletion(topLevel, subcommands));
        break;
      case 'zsh':
        process.stdout.write(generateZshCompletion(topLevel, subcommands));
        break;
      case 'fish':
        process.stdout.write(generateFishCompletion(topLevel, subcommands));
        break;
      default:
        log.error(`Unknown shell: ${shell}. Supported shells: bash, zsh, fish`);
        process.exit(1);
    }
  });

function generateBashCompletion(
  topLevel: string[],
  subcommands: Record<string, string[]>,
): string {
  const subcmdCases = Object.entries(subcommands)
    .map(([cmd, subs]) => `        ${cmd}) COMPREPLY=( $(compgen -W "${subs.join(' ')}" -- "$cur") ) ;;`)
    .join('\n');

  return `# vellum bash completion
# Add to ~/.bashrc: eval "$(vellum completions bash)"
_vellum_completions() {
    local cur prev words cword
    _init_completion || return

    if [[ $cword -eq 1 ]]; then
        COMPREPLY=( $(compgen -W "${topLevel.join(' ')} --help --version" -- "$cur") )
        return
    fi

    case "\${words[1]}" in
${subcmdCases}
        audit) COMPREPLY=( $(compgen -W "--limit -l" -- "$cur") ) ;;
        completions) COMPREPLY=( $(compgen -W "bash zsh fish" -- "$cur") ) ;;
    esac
}
complete -F _vellum_completions vellum
`;
}

function generateZshCompletion(
  topLevel: string[],
  subcommands: Record<string, string[]>,
): string {
  const subcmdCases = Object.entries(subcommands)
    .map(([cmd, subs]) => `        ${cmd}) compadd ${subs.join(' ')} ;;`)
    .join('\n');

  return `#compdef vellum
# vellum zsh completion
# Add to ~/.zshrc: eval "$(vellum completions zsh)"
_vellum() {
    local -a commands
    commands=(
        'daemon:Manage the daemon process'
        'dev:Run daemon in dev mode with auto-restart'
        'sessions:Manage sessions'
        'config:Manage configuration'
        'keys:Manage API keys in secure storage'
        'trust:Manage trust rules'
        'memory:Manage long-term memory'
        'hooks:Manage hooks'
        'contacts:Manage the contact graph'
        'autonomy:View and configure autonomy tiers'
        'audit:Show recent tool invocations'
        'doctor:Run diagnostic checks'
        'completions:Generate shell completion script'
        'help:Display help'
    )

    if (( CURRENT == 2 )); then
        _describe 'command' commands
        _arguments '--help[Show help]' '--version[Show version]'
        return
    fi

    case "\${words[2]}" in
${subcmdCases}
        audit) _arguments '-l[Number of entries]' '--limit[Number of entries]' ;;
        completions) compadd bash zsh fish ;;
    esac
}
compdef _vellum vellum
`;
}

function generateFishCompletion(
  topLevel: string[],
  subcommands: Record<string, string[]>,
): string {
  let script = `# vellum fish completion
# Add to ~/.config/fish/completions/vellum.fish or eval: vellum completions fish | source
`;

  // Disable file completions
  script += `complete -c vellum -f\n`;

  // Top-level commands
  const descriptions: Record<string, string> = {
    daemon: 'Manage the daemon process',
    dev: 'Run daemon in dev mode with auto-restart',
    sessions: 'Manage sessions',
    config: 'Manage configuration',
    keys: 'Manage API keys in secure storage',
    trust: 'Manage trust rules',
    memory: 'Manage long-term memory',
    hooks: 'Manage hooks',
    contacts: 'Manage the contact graph',
    autonomy: 'View and configure autonomy tiers',
    audit: 'Show recent tool invocations',
    doctor: 'Run diagnostic checks',
    completions: 'Generate shell completion script',
    help: 'Display help',
  };

  for (const cmd of topLevel) {
    const desc = descriptions[cmd] ?? '';
    script += `complete -c vellum -n '__fish_use_subcommand' -a '${cmd}' -d '${desc}'\n`;
  }
  script += `complete -c vellum -n '__fish_use_subcommand' -l help -d 'Show help'\n`;
  script += `complete -c vellum -n '__fish_use_subcommand' -l version -d 'Show version'\n`;

  // Subcommands
  for (const [cmd, subs] of Object.entries(subcommands)) {
    for (const sub of subs) {
      script += `complete -c vellum -n '__fish_seen_subcommand_from ${cmd}' -a '${sub}'\n`;
    }
  }

  // Audit options
  script += `complete -c vellum -n '__fish_seen_subcommand_from audit' -s l -l limit -d 'Number of entries'\n`;

  // Completions shell argument
  script += `complete -c vellum -n '__fish_seen_subcommand_from completions' -a 'bash zsh fish'\n`;

  return script;
}

const knownCommands = new Set(program.commands.map(cmd => cmd.name()));
const firstArg = process.argv[2];

if (firstArg && !firstArg.startsWith('-') && !knownCommands.has(firstArg)) {
  const cliPkgPath = require.resolve('@vellumai/cli/package.json');
  const cliEntry = join(dirname(cliPkgPath), 'src', 'index.ts');
  const child = spawn('bun', ['run', cliEntry, ...process.argv.slice(2)], {
    stdio: 'inherit',
  });
  child.on('exit', (code) => {
    process.exit(code ?? 1);
  });
} else {
  program.parse();
}
