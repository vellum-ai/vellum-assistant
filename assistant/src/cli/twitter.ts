/**
 * CLI command group: `vellum twitter`
 *
 * Post tweets and manage Twitter sessions via the command line.
 * All commands output JSON to stdout. Use --json for machine-readable output.
 */

import * as net from 'node:net';
import { Command } from 'commander';
import {
  loadSession,
  importFromRecording,
  clearSession,
} from '../twitter/session.js';
import {
  postTweet,
  SessionExpiredError,
} from '../twitter/client.js';
import { getSocketPath, readSessionToken } from '../util/platform.js';
import {
  serialize,
  createMessageParser,
} from '../daemon/ipc-protocol.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function output(data: unknown, json: boolean): void {
  process.stdout.write(
    json ? JSON.stringify(data) + '\n' : JSON.stringify(data, null, 2) + '\n',
  );
}

function outputError(message: string, code = 1): void {
  output({ ok: false, error: message }, true);
  process.exitCode = code;
}

function getJson(cmd: Command): boolean {
  let c: Command | null = cmd;
  while (c) {
    if ((c.opts() as { json?: boolean }).json) return true;
    c = c.parent;
  }
  return false;
}

const SESSION_EXPIRED_MSG =
  'Your Twitter session has expired. Please sign in to Twitter in Chrome — ' +
  'run `vellum twitter refresh` to capture your session automatically.';

async function run(cmd: Command, fn: () => Promise<unknown>): Promise<void> {
  try {
    const result = await fn();
    output(
      { ok: true, ...(result as Record<string, unknown>) },
      getJson(cmd),
    );
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      output(
        { ok: false, error: 'session_expired', message: SESSION_EXPIRED_MSG },
        getJson(cmd),
      );
      process.exitCode = 1;
      return;
    }
    outputError(err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerTwitterCommand(program: Command): void {
  const tw = program
    .command('x')
    .alias('twitter')
    .description(
      'Post on X and manage sessions. Requires a session imported from a Ride Shotgun recording.',
    )
    .option('--json', 'Machine-readable JSON output');

  // =========================================================================
  // login — import session from a recording
  // =========================================================================
  tw.command('login')
    .description('Import a Twitter session from a Ride Shotgun recording')
    .requiredOption(
      '--recording <path>',
      'Path to the recording JSON file',
    )
    .action(async (opts: { recording: string }, cmd: Command) => {
      await run(cmd, async () => {
        const session = importFromRecording(opts.recording);
        return {
          message: 'Session imported successfully',
          cookieCount: session.cookies.length,
          recordingId: session.recordingId,
        };
      });
    });

  // =========================================================================
  // logout — clear saved session
  // =========================================================================
  tw.command('logout')
    .description('Clear the saved Twitter session')
    .action((_opts: unknown, cmd: Command) => {
      clearSession();
      output({ ok: true, message: 'Session cleared' }, getJson(cmd));
    });

  // =========================================================================
  // refresh — start Ride Shotgun learn to capture fresh cookies
  // =========================================================================
  tw.command('refresh')
    .description(
      'Start a Ride Shotgun learn session to capture fresh Twitter cookies. ' +
      'Opens x.com in Chrome — sign in when prompted. ' +
      'NOTE: Chrome will restart with debugging enabled; your tabs will be restored.',
    )
    .option('--duration <seconds>', 'Recording duration in seconds', '180')
    .action(async (opts: { duration: string }, cmd: Command) => {
      const json = getJson(cmd);
      const duration = parseInt(opts.duration, 10);

      try {
        const result = await startLearnSession(duration);
        if (result.recordingPath) {
          const session = importFromRecording(result.recordingPath);

          // Hide Chrome after capturing session
          try { await minimizeChromeWindow(); } catch { /* best-effort */ }

          output(
            {
              ok: true,
              message: 'Session refreshed successfully',
              cookieCount: session.cookies.length,
              recordingId: result.recordingId,
            },
            json,
          );
        } else {
          output(
            {
              ok: false,
              error: 'Recording completed but no recording path returned',
              recordingId: result.recordingId,
            },
            json,
          );
          process.exitCode = 1;
        }
      } catch (err) {
        outputError(err instanceof Error ? err.message : String(err));
      }
    });

  // =========================================================================
  // status — check session status
  // =========================================================================
  tw.command('status')
    .description('Check if a Twitter session is active')
    .action((_opts: unknown, cmd: Command) => {
      const session = loadSession();
      if (session) {
        output(
          {
            ok: true,
            loggedIn: true,
            cookieCount: session.cookies.length,
            importedAt: session.importedAt,
            recordingId: session.recordingId,
          },
          getJson(cmd),
        );
      } else {
        output({ ok: true, loggedIn: false }, getJson(cmd));
      }
    });

  // =========================================================================
  // post — post a tweet
  // =========================================================================
  tw.command('post')
    .description('Post a tweet')
    .argument('<text>', 'Tweet text')
    .action(async (text: string, _opts: unknown, cmd: Command) => {
      await run(cmd, async () => {
        const result = await postTweet(text);
        return {
          tweetId: result.tweetId,
          text: result.text,
          url: result.url,
        };
      });
    });
}

// ---------------------------------------------------------------------------
// Chrome CDP restart helper
// ---------------------------------------------------------------------------

import { spawn as spawnChild } from 'node:child_process';
import { homedir } from 'node:os';
import { join as pathJoin } from 'node:path';

const CDP_BASE = 'http://localhost:9222';
const CHROME_DATA_DIR = pathJoin(
  homedir(),
  'Library/Application Support/Google/Chrome-CDP',
);

async function isCdpReady(): Promise<boolean> {
  try {
    const res = await fetch(`${CDP_BASE}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureChromeWithCDP(): Promise<void> {
  // Already running with CDP?
  if (await isCdpReady()) return;

  // Launch a separate Chrome instance with CDP flags alongside any existing Chrome.
  // Using a dedicated --user-data-dir allows coexistence without killing the user's browser.
  const chromeApp =
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  spawnChild(chromeApp, [
    `--remote-debugging-port=9222`,
    `--force-renderer-accessibility`,
    `--user-data-dir=${CHROME_DATA_DIR}`,
    'https://x.com/login',
  ], {
    detached: true,
    stdio: 'ignore',
  }).unref();

  // Wait for CDP to be ready
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await isCdpReady()) return;
  }
  throw new Error('Chrome started but CDP endpoint not responding after 15s');
}

async function minimizeChromeWindow(): Promise<void> {
  const res = await fetch(`${CDP_BASE}/json/list`);
  const targets = (await res.json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
  const pageTarget = targets.find(t => t.type === 'page');
  if (!pageTarget) return;

  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('CDP minimize timed out'));
    }, 5000);

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Browser.getWindowForTarget' }));
    });

    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as { id: number; result?: { windowId: number } };
      if (msg.id === 1 && msg.result) {
        ws.send(JSON.stringify({
          id: 2,
          method: 'Browser.setWindowBounds',
          params: { windowId: msg.result.windowId, bounds: { windowState: 'minimized' } },
        }));
      } else if (msg.id === 2) {
        clearTimeout(timeout);
        ws.close();
        resolve();
      }
    });

    ws.addEventListener('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Ride Shotgun learn session helper
// ---------------------------------------------------------------------------

interface LearnResult {
  recordingId?: string;
  recordingPath?: string;
}

async function navigateToX(): Promise<void> {
  try {
    const res = await fetch(`${CDP_BASE}/json/list`);
    if (!res.ok) return;
    const targets = (await res.json()) as Array<{ id: string; type: string; url: string }>;
    const tab = targets.find(t => t.type === 'page');
    if (!tab) return;
    await fetch(`${CDP_BASE}/json/navigate?url=${encodeURIComponent('https://x.com/login')}&id=${tab.id}`, { method: 'PUT' });
  } catch {
    // best-effort
  }
}

async function startLearnSession(durationSeconds: number): Promise<LearnResult> {
  await ensureChromeWithCDP();
  await navigateToX();

  return new Promise((resolve, reject) => {
    const socketPath = getSocketPath();
    const sessionToken = readSessionToken();
    const socket = net.createConnection(socketPath);
    const parser = createMessageParser();

    socket.on('error', (err) => {
      reject(new Error(`Cannot connect to daemon: ${err.message}. Is the daemon running?`));
    });

    const timeoutHandle = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Learn session timed out after ${durationSeconds + 30}s`));
    }, (durationSeconds + 30) * 1000);
    timeoutHandle.unref();

    let authenticated = !sessionToken;

    const sendStartCommand = () => {
      socket.write(
        serialize({
          type: 'ride_shotgun_start',
          durationSeconds,
          intervalSeconds: 5,
          mode: 'learn',
          targetDomain: 'x.com',
        } as unknown as import('../daemon/ipc-protocol.js').ClientMessage),
      );
    };

    socket.on('data', (chunk) => {
      const messages = parser.feed(chunk.toString('utf-8'));
      for (const msg of messages) {
        const m = msg as unknown as Record<string, unknown>;

        if (!authenticated && m.type === 'auth_result') {
          if ((m as { success: boolean }).success) {
            authenticated = true;
            sendStartCommand();
          } else {
            clearTimeout(timeoutHandle);
            socket.destroy();
            reject(new Error('Daemon authentication failed'));
          }
          continue;
        }

        if (m.type === 'auth_result') {
          continue;
        }

        if (m.type === 'ride_shotgun_result') {
          clearTimeout(timeoutHandle);
          socket.destroy();
          resolve({
            recordingId: m.recordingId as string | undefined,
            recordingPath: m.recordingPath as string | undefined,
          });
        }
      }
    });

    socket.on('connect', () => {
      if (sessionToken) {
        socket.write(
          serialize({
            type: 'auth',
            token: sessionToken,
          } as unknown as import('../daemon/ipc-protocol.js').ClientMessage),
        );
      } else {
        sendStartCommand();
      }
    });
  });
}
