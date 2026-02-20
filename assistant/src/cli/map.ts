/**
 * CLI command: `vellum map <domain>`
 *
 * Launches Chrome with CDP, starts a Ride Shotgun learn session to auto-navigate
 * the given domain, then analyzes captured network traffic into a deduplicated API map.
 */

import * as net from 'node:net';
import { spawn as spawnChild } from 'node:child_process';
import { homedir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { Command } from 'commander';
import { getSocketPath, readSessionToken } from '../util/platform.js';
import {
  serialize,
  createMessageParser,
} from '../daemon/ipc-protocol.js';
import { parse as parseTld } from 'tldts';
import { loadRecording } from '../tools/browser/recording-store.js';
import { analyzeApiMap, saveApiMap, printApiMapTable } from '../tools/browser/api-map.js';

/**
 * Extract the registrable base domain from a hostname.
 * e.g. "open.spotify.com" → "spotify.com", "connect.garmin.com" → "garmin.com"
 * Falls back to the input if tldts can't parse it.
 */
function getBaseDomain(domain: string): string {
  const result = parseTld(domain);
  return result.domain ?? domain;
}

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

// ---------------------------------------------------------------------------
// Chrome CDP helpers
// ---------------------------------------------------------------------------

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

async function ensureChromeWithCDP(domain: string): Promise<void> {
  // Already running with CDP?
  if (await isCdpReady()) return;

  // Launch a separate Chrome instance with CDP flags alongside any existing Chrome.
  const chromeApp =
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  spawnChild(chromeApp, [
    `--remote-debugging-port=9222`,
    `--force-renderer-accessibility`,
    `--user-data-dir=${CHROME_DATA_DIR}`,
    `https://${domain}/`,
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

// ---------------------------------------------------------------------------
// Ride Shotgun learn session helper
// ---------------------------------------------------------------------------

interface LearnResult {
  recordingId?: string;
  recordingPath?: string;
}

async function startLearnSession(
  navigateDomain: string,
  recordDomain: string,
  durationSeconds: number,
): Promise<LearnResult> {
  await ensureChromeWithCDP(navigateDomain);

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
          targetDomain: recordDomain,
          navigateDomain,
          autoNavigate: true,
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

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerMapCommand(program: Command): void {
  program
    .command('map')
    .description(
      'Auto-navigate a domain and produce a deduplicated API map. ' +
      'Launches Chrome with CDP, starts a Ride Shotgun learn session, ' +
      'then analyzes captured network traffic.',
    )
    .argument('<domain>', 'Domain to map (e.g., example.com)')
    .option('--duration <seconds>', 'Recording duration in seconds', '120')
    .option('--json', 'Machine-readable JSON output')
    .action(async (domain: string, opts: { duration: string; json?: boolean }, cmd: Command) => {
      const json = getJson(cmd);
      const duration = parseInt(opts.duration, 10);

      try {
        // Split into navigation domain (what Chrome browses) and recording domain (network filter).
        // e.g. "open.spotify.com" → navigate open.spotify.com, record *.spotify.com
        const navigateDomain = domain;
        const recordDomain = getBaseDomain(domain);

        if (!json) {
          if (navigateDomain !== recordDomain) {
            console.log(`Starting API map session: navigating ${navigateDomain}, recording *.${recordDomain} (${duration}s)...`);
          } else {
            console.log(`Starting API map session for ${domain} (${duration}s)...`);
          }
        }
        const result = await startLearnSession(navigateDomain, recordDomain, duration);

        if (!result.recordingId) {
          outputError('Recording completed but no recording ID returned');
          return;
        }

        // 2. Load the recording
        const recording = loadRecording(result.recordingId);
        if (!recording) {
          outputError(`Failed to load recording ${result.recordingId}`);
          return;
        }

        // 3. Analyze the API map
        const apiMap = analyzeApiMap(recording.networkEntries, domain);

        // 4. Save the API map
        const savedPath = saveApiMap(domain, apiMap);

        // 5. Display results
        if (!json) {
          printApiMapTable(apiMap);
          console.log(`API map saved to: ${savedPath}`);
        }

        // 6. Output JSON result
        output(
          {
            ok: true,
            domain,
            recordingId: result.recordingId,
            savedPath,
            totalRequests: apiMap.totalRequests,
            endpointCount: apiMap.endpoints.length,
            apiMap,
          },
          json,
        );
      } catch (err) {
        outputError(err instanceof Error ? err.message : String(err));
      }
    });
}
