#!/usr/bin/env bun

import { Command } from 'commander';
import * as net from 'node:net';
import {
  ensureDaemonRunning,
  startDaemon,
  stopDaemon,
  getDaemonStatus,
} from './daemon/lifecycle.js';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { startCli } from './cli.js';
import { getSocketPath, getDataDir, getDbPath } from './util/platform.js';
import {
  serialize,
  createMessageParser,
  type ClientMessage,
  type ServerMessage,
} from './daemon/ipc-protocol.js';
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
import { getRecentInvocations } from './memory/tool-usage-store.js';

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
        reject(new Error('Socket closed before receiving a response'));
      }
    });
  });
}

const program = new Command();

program
  .name('vellum')
  .description('Local AI assistant')
  .version('0.1.0')
  .action(async () => {
    await ensureDaemonRunning();
    await startCli();
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
          console.log(`  ${s.id}  ${s.title}`);
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

    // 2. API key configured
    const raw = loadRawConfig();
    const envKey = process.env.ANTHROPIC_API_KEY;
    const configKey = (raw.apiKeys as Record<string, string> | undefined)?.anthropic;
    if (envKey || configKey) {
      pass('API key configured');
    } else {
      fail('API key configured', 'set ANTHROPIC_API_KEY or run: vellum config set apiKeys.anthropic <key>');
    }

    // 3. Daemon reachable
    try {
      const sock = getSocketPath();
      if (!existsSync(sock)) {
        fail('Daemon reachable', 'socket not found (is the daemon running?)');
      } else {
        await new Promise<void>((resolve, reject) => {
          const s = net.createConnection(sock);
          const timer = setTimeout(() => { s.destroy(); reject(new Error('timeout')); }, 2000);
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
    const requiredDirs = [dataDir, `${dataDir}/data`, `${dataDir}/logs`];
    const missing = requiredDirs.filter((d) => !existsSync(d));
    if (missing.length === 0) {
      pass('Directory structure exists');
    } else {
      fail('Directory structure exists', `missing: ${missing.join(', ')}`);
    }
  });

program.parse();
