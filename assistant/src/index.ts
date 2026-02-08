#!/usr/bin/env bun

import { Command } from 'commander';
import * as net from 'node:net';
import {
  ensureDaemonRunning,
  startDaemon,
  stopDaemon,
  getDaemonStatus,
} from './daemon/lifecycle.js';
import { startCli } from './cli.js';
import { getSocketPath } from './util/platform.js';
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

program.parse();
