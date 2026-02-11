#!/usr/bin/env bun

import { Command } from 'commander';
import { createRequire } from 'node:module';
import * as net from 'node:net';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };
import {
  ensureDaemonRunning,
  startDaemon,
  stopDaemon,
  getDaemonStatus,
} from './daemon/lifecycle.js';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { startCli } from './cli.js';
import { getSocketPath, getDataDir, getDbPath, getLogPath } from './util/platform.js';
import {
  serialize,
  createMessageParser,
  type ClientMessage,
  type ServerMessage,
} from './daemon/ipc-protocol.js';
import { IpcError } from './util/errors.js';
import { timeAgo } from './util/time.js';
import {
  loadRawConfig,
  saveRawConfig,
  getNestedValue,
  setNestedValue,
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
import { formatMarkdown, formatJson } from './export/formatter.js';
import {
  getMemorySystemStatus,
  queryMemory,
  requestMemoryBackfill,
  requestMemoryRebuildIndex,
} from './memory/admin.js';

function sendOneMessage(
  msg: ClientMessage,
): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(getSocketPath());
    const parser = createMessageParser();
    let resolved = false;

    socket.on('connect', () => {
      socket.write(serialize(msg));
    });

    socket.on('data', (data) => {
      const messages = parser.feed(data.toString()) as ServerMessage[];
      for (const m of messages) {
        // Skip the initial session_info that the server sends on connect
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

const program = new Command();

program
  .name('vellum')
  .description('Local AI assistant')
  .version(version)
  .option('--no-sandbox', 'Disable sandbox for this session (runtime override, not persisted)')
  .action(async (opts: { sandbox?: boolean }) => {
    await ensureDaemonRunning();
    await startCli({ noSandbox: opts.sandbox === false });
  });

const daemon = program.command('daemon').description('Manage the daemon process');

daemon
  .command('start')
  .description('Start the daemon')
  .action(async () => {
    const result = await startDaemon();
    if (result.alreadyRunning) {
      console.log(`Daemon already running (pid ${result.pid})`);
    } else {
      console.log(`Daemon started (pid ${result.pid})`);
    }
  });

daemon
  .command('stop')
  .description('Stop the daemon')
  .action(async () => {
    const result = await stopDaemon();
    if (result.stopped) {
      console.log('Daemon stopped');
    } else {
      console.log('Daemon is not running');
    }
  });

daemon
  .command('restart')
  .description('Restart the daemon')
  .action(async () => {
    const stopResult = await stopDaemon();
    if (stopResult.stopped) {
      console.log('Daemon stopped');
    }
    const startResult = await startDaemon();
    console.log(`Daemon started (pid ${startResult.pid})`);
  });

daemon
  .command('status')
  .description('Show daemon status')
  .action(() => {
    const status = getDaemonStatus();
    if (status.running) {
      console.log(`Daemon is running (pid ${status.pid})`);
    } else {
      console.log('Daemon is not running');
    }
  });

const sessions = program.command('sessions').description('Manage sessions');

sessions
  .command('list')
  .description('List all sessions')
  .action(async () => {
    await ensureDaemonRunning();
    const response = await sendOneMessage({ type: 'session_list' });
    if (response.type === 'session_list_response') {
      if (response.sessions.length === 0) {
        console.log('No sessions');
      } else {
        for (const s of response.sessions) {
          console.log(`  ${s.id}  ${s.title}  ${timeAgo(s.updatedAt)}`);
        }
      }
    } else if (response.type === 'error') {
      console.error(`Error: ${response.message}`);
    }
  });

sessions
  .command('new [title]')
  .description('Create a new session')
  .action(async (title?: string) => {
    await ensureDaemonRunning();
    const response = await sendOneMessage({
      type: 'session_create',
      title,
    });
    if (response.type === 'session_info') {
      console.log(`Created session: ${response.title} (${response.sessionId})`);
    } else if (response.type === 'error') {
      console.error(`Error: ${response.message}`);
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
      console.error('Error: format must be "md" or "json"');
      process.exit(1);
    }

    // If no session ID given, pick the most recent one
    let id = sessionId;
    if (!id) {
      const all = listConversations(1);
      if (all.length === 0) {
        console.error('No sessions found');
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
        console.error(`Session not found: ${id}`);
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
      console.error(`Exported to ${opts.output}`);
    } else {
      process.stdout.write(output);
    }
  });

sessions
  .command('clear')
  .description('Clear all chat messages from both the daemon DB and the web Postgres DB (dev only)')
  .action(async () => {
    // ── Resolve DATABASE_URL ──────────────────────────────────────────
    let databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      const { resolve } = await import('node:path');
      const envLocalPath = resolve(import.meta.dirname, '../../web/.env.local');
      try {
        const envContent = readFileSync(envLocalPath, 'utf-8');
        const match = envContent.match(/^DATABASE_URL=(.+)$/m);
        if (match) databaseUrl = match[1].trim().replace(/^['"]|['"]$/g, '');
      } catch {
        // .env.local not found — will warn below
      }
    }

    // ── Safety: only allow localhost ──────────────────────────────────
    let pgAvailable = false;
    if (databaseUrl) {
      const host = new URL(databaseUrl).hostname;
      const allowedHosts = ['localhost', '127.0.0.1', '0.0.0.0', 'host.docker.internal'];
      if (!allowedHosts.includes(host)) {
        console.error(`Error: DATABASE_URL points to '${host}' — refusing to run.`);
        console.error('This command is dev-only and will only run against localhost databases.');
        process.exit(1);
      }
      pgAvailable = true;
    } else {
      console.log('Warning: DATABASE_URL not set — will only clear daemon DB.');
    }

    // ── Safety: reject databases with many users ─────────────────────
    if (pgAvailable && databaseUrl) {
      const postgres = (await import('postgres')).default;
      const checkSql = postgres(databaseUrl, { max: 1 });
      try {
        const [{ count: userCount }] = await checkSql`SELECT COUNT(*)::int AS count FROM "user"`;
        if (userCount >= 10) {
          console.error(`Error: database has ${userCount} users — this looks like a production database.`);
          console.error('This command is dev-only and will only run against small dev databases.');
          process.exit(1);
        }
      } catch (err: unknown) {
        const isUndefinedTable = err instanceof Error && 'code' in err && (err as Record<string, unknown>).code === '42P01';
        if (!isUndefinedTable) throw err;
      } finally {
        await checkSql.end();
      }
    }

    // ── Confirmation prompt ──────────────────────────────────────────
    const parts: string[] = ['daemon SQLite database'];
    if (pgAvailable) parts.push('web Postgres database');
    console.log(`This will permanently delete all conversations and messages from: ${parts.join(', ')}.`);

    const readline = await import('node:readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question('Are you sure? (y/N) ', resolve);
    });
    rl.close();
    if (answer.toLowerCase() !== 'y') {
      console.log('Cancelled');
      return;
    }

    // ── Clear daemon SQLite ──────────────────────────────────────────
    initializeDb();
    const result = clearAllConversations();
    console.log(`Daemon DB: cleared ${result.conversations} conversations, ${result.messages} messages`);

    // ── Clear web Postgres ───────────────────────────────────────────
    if (pgAvailable && databaseUrl) {
      const postgres = (await import('postgres')).default;
      const sql = postgres(databaseUrl, { max: 1 });
      try {
        const msgs = await sql`DELETE FROM chat_messages`;
        const attachments = await sql`DELETE FROM chat_attachments`;
        console.log(`Postgres: cleared ${msgs.count} messages, ${attachments.count} attachments`);
      } finally {
        await sql.end();
      }
    }

    console.log('Done.');
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
    console.log(`Set ${key} = ${JSON.stringify(parsed)}`);
  });

config
  .command('get <key>')
  .description('Get a config value (supports dotted paths)')
  .action((key: string) => {
    const raw = loadRawConfig();
    const value = getNestedValue(raw, key);
    if (value === undefined) {
      console.log(`(not set)`);
    } else {
      console.log(typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value));
    }
  });

config
  .command('list')
  .description('List all config values')
  .action(() => {
    const raw = loadRawConfig();
    if (Object.keys(raw).length === 0) {
      console.log('No configuration set');
    } else {
      console.log(JSON.stringify(raw, null, 2));
    }
  });

// --- Keys commands ---
const keys = program.command('keys').description('Manage API keys in secure storage');

keys
  .command('list')
  .description('List all stored API key names')
  .action(() => {
    const stored: string[] = [];
    for (const provider of ['anthropic', 'openai', 'gemini', 'ollama']) {
      const value = getSecureKey(provider);
      if (value) stored.push(provider);
    }
    if (stored.length === 0) {
      console.log('No API keys stored');
    } else {
      for (const name of stored) {
        console.log(`  ${name}`);
      }
    }
  });

keys
  .command('set <provider> <key>')
  .description('Store an API key (e.g. vellum keys set anthropic sk-ant-...)')
  .action((provider: string, key: string) => {
    if (setSecureKey(provider, key)) {
      console.log(`Stored API key for "${provider}"`);
    } else {
      console.error(`Failed to store API key for "${provider}"`);
      process.exit(1);
    }
  });

keys
  .command('delete <provider>')
  .description('Delete a stored API key')
  .action((provider: string) => {
    if (deleteSecureKey(provider)) {
      console.log(`Deleted API key for "${provider}"`);
    } else {
      console.error(`No API key found for "${provider}"`);
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
      console.log('No trust rules');
      return;
    }
    // Table header
    const idW = 8;
    const toolW = 12;
    const patternW = 30;
    const scopeW = 20;
    console.log(
      'ID'.padEnd(idW) +
      'Tool'.padEnd(toolW) +
      'Pattern'.padEnd(patternW) +
      'Scope'.padEnd(scopeW) +
      'Created',
    );
    console.log('-'.repeat(idW + toolW + patternW + scopeW + 20));
    for (const r of rules) {
      const id = r.id.slice(0, 8);
      const created = new Date(r.createdAt).toISOString().slice(0, 10);
      console.log(
        id.padEnd(idW) +
        r.tool.padEnd(toolW) +
        r.pattern.slice(0, patternW - 2).padEnd(patternW) +
        r.scope.slice(0, scopeW - 2).padEnd(scopeW) +
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
      console.error(`No rule found matching "${id}"`);
      process.exit(1);
    }
    removeRule(match.id);
    console.log(`Removed rule ${match.id.slice(0, 8)} (${match.tool}: ${match.pattern})`);
  });

trust
  .command('clear')
  .description('Remove all trust rules')
  .action(async () => {
    const rules = getAllRules();
    if (rules.length === 0) {
      console.log('No trust rules to clear');
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
      console.log(`Cleared ${rules.length} trust rules`);
    } else {
      console.log('Cancelled');
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
    console.log(`Memory enabled: ${status.enabled ? 'yes' : 'no'}`);
    console.log(`Memory degraded: ${status.degraded ? 'yes' : 'no'}`);
    if (status.reason) console.log(`Reason: ${status.reason}`);
    if (status.provider && status.model) {
      console.log(`Embedding backend: ${status.provider}/${status.model}`);
    } else {
      console.log('Embedding backend: none');
    }
    console.log(`Segments: ${status.counts.segments.toLocaleString()}`);
    console.log(`Items: ${status.counts.items.toLocaleString()}`);
    console.log(`Summaries: ${status.counts.summaries.toLocaleString()}`);
    console.log(`Embeddings: ${status.counts.embeddings.toLocaleString()}`);
    console.log('Jobs:');
    for (const [key, value] of Object.entries(status.jobs)) {
      console.log(`  ${key}: ${value}`);
    }
  });

memory
  .command('backfill')
  .description('Queue a memory backfill job')
  .option('-f, --force', 'Restart backfill from the beginning')
  .action((opts: { force?: boolean }) => {
    initializeDb();
    const jobId = requestMemoryBackfill(Boolean(opts?.force));
    console.log(`Queued backfill job: ${jobId}`);
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
      console.log(`Memory degraded: ${result.reason ?? 'unknown reason'}`);
    }
    console.log(`Lexical hits: ${result.lexicalHits}`);
    console.log(`Semantic hits: ${result.semanticHits}`);
    console.log(`Recency hits: ${result.recencyHits}`);
    console.log(`Injected tokens: ${result.injectedTokens}`);
    console.log(`Latency: ${result.latencyMs}ms`);
    if (result.injectedText.length > 0) {
      console.log('');
      console.log(result.injectedText);
    } else {
      console.log('No memory injected.');
    }
  });

memory
  .command('rebuild-index')
  .description('Queue a memory FTS+embedding index rebuild job')
  .action(() => {
    initializeDb();
    const jobId = requestMemoryRebuildIndex();
    console.log(`Queued rebuild-index job: ${jobId}`);
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
      console.log('No tool invocations recorded');
      return;
    }
    const tsW = 20;
    const toolW = 14;
    const inputW = 30;
    const decW = 8;
    const riskW = 8;
    const durW = 8;
    console.log(
      'Timestamp'.padEnd(tsW) +
      'Tool'.padEnd(toolW) +
      'Input'.padEnd(inputW) +
      'Decision'.padEnd(decW) +
      'Risk'.padEnd(riskW) +
      'Duration',
    );
    console.log('-'.repeat(tsW + toolW + inputW + decW + riskW + durW));
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
      console.log(
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
    const pass = (label: string) => console.log(`  \u2713 ${label}`);
    const fail = (label: string, detail?: string) =>
      console.log(`  \u2717 ${label}${detail ? ` — ${detail}` : ''}`);

    console.log('Vellum Doctor\n');

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

    // 5. ~/.vellum/ directory structure
    const dataDir = getDataDir();
    const requiredDirs = [dataDir, `${dataDir}/data`, `${dataDir}/logs`, `${dataDir}/skills`];
    const missing = requiredDirs.filter((d) => !existsSync(d));
    if (missing.length === 0) {
      pass('Directory structure exists');
    } else {
      fail('Directory structure exists', `missing: ${missing.join(', ')}`);
    }

    // 6. Disk space
    try {
      const output = execSync(`df -k "${dataDir}"`, { stdio: 'pipe', encoding: 'utf-8' });
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
    const trustPath = `${dataDir}/trust.json`;
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
  });

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
    };
    const topLevel = [
      'daemon', 'sessions', 'config', 'keys', 'trust', 'memory',
      'audit', 'doctor', 'completions', 'help',
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
        console.error(`Unknown shell: ${shell}. Supported shells: bash, zsh, fish`);
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
        COMPREPLY=( $(compgen -W "${topLevel.join(' ')} --help --version --no-sandbox" -- "$cur") )
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
        'sessions:Manage sessions'
        'config:Manage configuration'
        'keys:Manage API keys in secure storage'
        'trust:Manage trust rules'
        'memory:Manage long-term memory'
        'audit:Show recent tool invocations'
        'doctor:Run diagnostic checks'
        'completions:Generate shell completion script'
        'help:Display help'
    )

    if (( CURRENT == 2 )); then
        _describe 'command' commands
        _arguments '--help[Show help]' '--version[Show version]' '--no-sandbox[Disable sandbox]'
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
    sessions: 'Manage sessions',
    config: 'Manage configuration',
    keys: 'Manage API keys in secure storage',
    trust: 'Manage trust rules',
    memory: 'Manage long-term memory',
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
  script += `complete -c vellum -n '__fish_use_subcommand' -l no-sandbox -d 'Disable sandbox'\n`;

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

program.parse();
