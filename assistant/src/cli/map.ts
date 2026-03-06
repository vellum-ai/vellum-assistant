/**
 * CLI command: `vellum map <domain>`
 *
 * Launches Chrome with CDP, starts a Ride Shotgun learn session to auto-navigate
 * the given domain, then analyzes captured network traffic into a deduplicated API map.
 */

import * as net from "node:net";

import { Command } from "commander";
import { parse as parseTld } from "tldts";

import { createMessageParser, serialize } from "../daemon/ipc-protocol.js";
import {
  analyzeApiMap,
  printApiMapTable,
  saveApiMap,
} from "../tools/browser/api-map.js";
import { ensureChromeWithCdp } from "../tools/browser/chrome-cdp.js";
import { loadRecording } from "../tools/browser/recording-store.js";
import { getCliLogger } from "../util/logger.js";
import { getSocketPath, readSessionToken } from "../util/platform.js";

const log = getCliLogger("cli:map");

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
    json ? JSON.stringify(data) + "\n" : JSON.stringify(data, null, 2) + "\n",
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

/**
 * Bring the Chrome CDP tab to the foreground so the user sees the right window.
 * Optionally navigates to a URL first (used when Chrome was already running).
 */
async function bringChromeToFront(
  cdpBase: string,
  navigateUrl?: string,
): Promise<string | null> {
  try {
    const res = await fetch(`${cdpBase}/json/list`);
    if (!res.ok) return null;
    const targets = (await res.json()) as Array<{
      type: string;
      url: string;
      webSocketDebuggerUrl: string;
    }>;
    const pageTarget = targets.find((t) => t.type === "page");
    if (!pageTarget?.webSocketDebuggerUrl) return null;

    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(new Error(`CDP WebSocket error: ${e}`));
    });

    let nextId = 1;
    const cdpSend = (
      method: string,
      params?: Record<string, unknown>,
    ): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        const cleanup = () => {
          clearTimeout(timeout);
          ws.removeEventListener("message", handler);
          ws.removeEventListener("close", onClose);
          ws.removeEventListener("error", onError);
        };
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error(`CDP command ${method} timed out`));
        }, 5000);
        const onClose = () => {
          cleanup();
          reject(new Error("WebSocket closed before CDP response"));
        };
        const onError = (e: Event) => {
          cleanup();
          reject(new Error(`WebSocket error: ${e}`));
        };
        const handler = (event: MessageEvent) => {
          const msg = JSON.parse(String(event.data));
          if (msg.id === id) {
            cleanup();
            if (msg.error) reject(new Error(msg.error.message));
            else resolve(msg.result);
          }
        };
        ws.addEventListener("message", handler);
        ws.addEventListener("close", onClose);
        ws.addEventListener("error", onError);
        ws.send(JSON.stringify({ id, method, params }));
      });

    if (navigateUrl) {
      await cdpSend("Page.navigate", { url: navigateUrl });
      // Brief wait for navigation to start
      await new Promise((r) => setTimeout(r, 500));
    }

    await cdpSend("Page.bringToFront");
    const tabUrl = navigateUrl ?? pageTarget.url;
    ws.close();
    return tabUrl;
  } catch {
    return null;
  }
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
  autoNavigate: boolean = true,
): Promise<LearnResult> {
  const cdpSession = await ensureChromeWithCdp({
    startUrl: `https://${navigateDomain}/`,
  });

  // Activate the Chrome window so the user knows which tab to watch
  const tabUrl = await bringChromeToFront(
    cdpSession.baseUrl,
    `https://${navigateDomain}/`,
  );
  if (tabUrl) {
    process.stderr.write(`Chrome is ready — using tab at ${tabUrl}\n`);
  }

  return new Promise((resolve, reject) => {
    const socketPath = getSocketPath();
    const sessionToken = readSessionToken();
    const socket = net.createConnection(socketPath);
    const parser = createMessageParser();

    socket.on("error", (err) => {
      reject(
        new Error(
          `Cannot connect to assistant: ${err.message}. Is the assistant running?`,
        ),
      );
    });

    const timeoutHandle = setTimeout(
      () => {
        socket.destroy();
        reject(
          new Error(`Learn session timed out after ${durationSeconds + 30}s`),
        );
      },
      (durationSeconds + 30) * 1000,
    );
    timeoutHandle.unref();

    let authenticated = !sessionToken;

    const sendStartCommand = () => {
      socket.write(
        serialize({
          type: "ride_shotgun_start",
          durationSeconds,
          intervalSeconds: 5,
          mode: "learn",
          targetDomain: recordDomain,
          navigateDomain,
          autoNavigate,
        } as unknown as import("../daemon/ipc-protocol.js").ClientMessage),
      );
    };

    socket.on("data", (chunk) => {
      const messages = parser.feed(chunk.toString("utf-8"));
      for (const msg of messages) {
        const m = msg as unknown as Record<string, unknown>;

        if (!authenticated && m.type === "auth_result") {
          if ((m as { success: boolean }).success) {
            authenticated = true;
            sendStartCommand();
          } else {
            clearTimeout(timeoutHandle);
            socket.destroy();
            reject(new Error("Authentication failed"));
          }
          continue;
        }

        if (m.type === "auth_result") {
          continue;
        }

        if (m.type === "ride_shotgun_progress") {
          // Live progress from auto-navigator
          process.stderr.write(`  ${m.message}\n`);
          continue;
        }

        if (m.type === "ride_shotgun_error") {
          clearTimeout(timeoutHandle);
          socket.destroy();
          reject(new Error((m as { message: string }).message));
          continue;
        }

        if (m.type === "ride_shotgun_result") {
          clearTimeout(timeoutHandle);
          socket.destroy();
          resolve({
            recordingId: m.recordingId as string | undefined,
            recordingPath: m.recordingPath as string | undefined,
          });
        }
      }
    });

    socket.on("connect", () => {
      if (sessionToken) {
        socket.write(
          serialize({
            type: "auth",
            token: sessionToken,
          } as unknown as import("../daemon/ipc-protocol.js").ClientMessage),
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
    .command("map")
    .description(
      "Auto-navigate a domain and produce a deduplicated API map. " +
        "Launches Chrome with CDP, starts a Ride Shotgun learn session, " +
        "then analyzes captured network traffic.",
    )
    .argument("<domain>", "Domain to map (e.g., example.com)")
    .option("--duration <seconds>", "Recording duration in seconds")
    .option(
      "--manual",
      "Manual mode: browse the site yourself while network traffic is recorded",
    )
    .option("--json", "Machine-readable JSON output")
    .addHelpText(
      "after",
      `
Arguments:
  domain   The domain to map (e.g. example.com, open.spotify.com). Subdomains
           are navigated directly but network traffic is recorded for the
           entire base domain (e.g. open.spotify.com navigates that subdomain
           but records all *.spotify.com traffic).

Two modes of operation:
  auto (default)   The assistant auto-navigates the site using Ride Shotgun,
                   clicking links and exploring pages autonomously. Default
                   duration: 120 seconds.
  --manual         You browse the site yourself while network traffic is
                   recorded in the background. Default duration: 60 seconds.

How it works:
  1. Launches Chrome with Chrome DevTools Protocol (CDP) enabled
  2. Starts a Ride Shotgun learn session to capture network traffic
  3. Deduplicates captured requests into unique API endpoints
  4. Saves the API map to disk and prints a summary table

The assistant must be running (the learn session is coordinated through it).

Examples:
  $ vellum map example.com
  $ vellum map open.spotify.com --duration 180
  $ vellum map garmin.com --manual`,
    )
    .action(
      async (
        domain: string,
        opts: { duration?: string; manual?: boolean; json?: boolean },
        cmd: Command,
      ) => {
        const json = getJson(cmd);
        const manual = opts.manual ?? false;
        const duration = opts.duration
          ? parseInt(opts.duration, 10)
          : manual
            ? 60
            : 120;

        try {
          // Split into navigation domain (what Chrome browses) and recording domain (network filter).
          // e.g. "open.spotify.com" → navigate open.spotify.com, record *.spotify.com
          const navigateDomain = domain;
          const recordDomain = getBaseDomain(domain);

          if (!json) {
            if (manual) {
              log.info(
                `Starting manual API map session for ${domain} (${duration}s)...`,
              );
              log.info(
                "Browse the site manually. Press Ctrl+C or wait for idle detection to stop recording.",
              );
            } else if (navigateDomain !== recordDomain) {
              log.info(
                `Starting API map session: navigating ${navigateDomain}, recording *.${recordDomain} (${duration}s)...`,
              );
            } else {
              log.info(
                `Starting API map session for ${domain} (${duration}s)...`,
              );
            }
          }
          const result = await startLearnSession(
            navigateDomain,
            recordDomain,
            duration,
            !manual,
          );

          if (!result.recordingId) {
            outputError("Recording completed but no recording ID returned");
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
            log.info(`API map saved to: ${savedPath}`);
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
      },
    );
}
