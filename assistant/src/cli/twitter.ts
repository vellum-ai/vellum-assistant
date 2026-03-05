/**
 * CLI command group: `vellum twitter`
 *
 * Post tweets and manage Twitter sessions via the command line.
 * All commands output JSON to stdout. Use --json for machine-readable output.
 */

import * as net from "node:net";

import { Command } from "commander";

import { createMessageParser, serialize } from "../daemon/ipc-protocol.js";
import {
  getBookmarks,
  getFollowers,
  getFollowing,
  getHomeTimeline,
  getLikes,
  getNotifications,
  getTweetDetail,
  getUserByScreenName,
  getUserMedia,
  getUserTweets,
  searchTweets,
  SessionExpiredError,
} from "../twitter/client.js";
import { routedPostTweet } from "../twitter/router.js";
import {
  clearSession,
  importFromRecording,
  loadSession,
} from "../twitter/session.js";
import { getSocketPath, readSessionToken } from "../util/platform.js";

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

const SESSION_EXPIRED_MSG =
  "Your Twitter session has expired. Please sign in to Twitter in Chrome — " +
  "run `vellum twitter refresh` to capture your session automatically.";

async function run(cmd: Command, fn: () => Promise<unknown>): Promise<void> {
  try {
    const result = await fn();
    output({ ok: true, ...(result as Record<string, unknown>) }, getJson(cmd));
  } catch (err) {
    const meta = err as Record<string, unknown>;
    if (err instanceof SessionExpiredError) {
      // Preserve backward-compatible error code while surfacing router metadata
      const payload: Record<string, unknown> = {
        ok: false,
        error: "session_expired",
        message: SESSION_EXPIRED_MSG,
      };
      if (meta.pathUsed !== undefined) payload.pathUsed = meta.pathUsed;
      if (meta.suggestAlternative !== undefined)
        payload.suggestAlternative = meta.suggestAlternative;
      if (meta.oauthError !== undefined) payload.oauthError = meta.oauthError;
      output(payload, getJson(cmd));
      process.exitCode = 1;
      return;
    }
    // For routed errors with any router metadata, emit structured JSON
    // so callers can see dual-path diagnostics (pathUsed, oauthError, etc.)
    if (
      err instanceof Error &&
      (meta.pathUsed !== undefined ||
        meta.suggestAlternative !== undefined ||
        meta.oauthError !== undefined)
    ) {
      const payload: Record<string, unknown> = {
        ok: false,
        error: err.message,
      };
      if (meta.pathUsed !== undefined) payload.pathUsed = meta.pathUsed;
      if (meta.suggestAlternative !== undefined)
        payload.suggestAlternative = meta.suggestAlternative;
      if (meta.oauthError !== undefined) payload.oauthError = meta.oauthError;
      output(payload, getJson(cmd));
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
    .command("x")
    .alias("twitter")
    .description(
      "Post on X and manage connections. Supports OAuth (official API) and browser session paths.",
    )
    .option("--json", "Machine-readable JSON output");

  // =========================================================================
  // login — import session from a recording
  // =========================================================================
  tw.command("login")
    .description("Import a Twitter session from a Ride Shotgun recording")
    .requiredOption("--recording <path>", "Path to the recording JSON file")
    .action(async (opts: { recording: string }, cmd: Command) => {
      await run(cmd, async () => {
        const session = importFromRecording(opts.recording);
        return {
          message: "Session imported successfully",
          cookieCount: session.cookies.length,
          recordingId: session.recordingId,
        };
      });
    });

  // =========================================================================
  // logout — clear saved session
  // =========================================================================
  tw.command("logout")
    .description("Clear the saved Twitter session")
    .action((_opts: unknown, cmd: Command) => {
      clearSession();
      output({ ok: true, message: "Session cleared" }, getJson(cmd));
    });

  // =========================================================================
  // refresh — start Ride Shotgun learn to capture fresh cookies
  // =========================================================================
  tw.command("refresh")
    .description(
      "Start a Ride Shotgun learn session to capture fresh Twitter cookies. " +
        "Opens x.com in Chrome — sign in when prompted. " +
        "NOTE: Chrome will restart with debugging enabled; your tabs will be restored.",
    )
    .option("--duration <seconds>", "Recording duration in seconds", "180")
    .action(async (opts: { duration: string }, cmd: Command) => {
      const json = getJson(cmd);
      const duration = parseInt(opts.duration, 10);

      try {
        const result = await startLearnSession(duration);
        if (result.recordingPath) {
          const session = importFromRecording(result.recordingPath);

          // Hide Chrome after capturing session
          try {
            await minimizeChromeWindow(); // uses default CDP port
          } catch {
            /* best-effort */
          }

          output(
            {
              ok: true,
              message: "Session refreshed successfully",
              cookieCount: session.cookies.length,
              recordingId: result.recordingId,
            },
            json,
          );
        } else {
          output(
            {
              ok: false,
              error: "Recording completed but no recording path returned",
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
  // status — check session status + OAuth and strategy info
  // =========================================================================
  tw.command("status")
    .description("Check Twitter session, OAuth, and strategy status")
    .action(async (_opts: unknown, cmd: Command) => {
      const session = loadSession();
      const browserInfo: Record<string, unknown> = session
        ? {
            browserSessionActive: true,
            cookieCount: session.cookies.length,
            importedAt: session.importedAt,
            recordingId: session.recordingId,
          }
        : { browserSessionActive: false };

      // Query daemon for OAuth / strategy config
      let oauthInfo: Record<string, unknown> = {};
      try {
        const daemonResponse = await sendDaemonMessage(
          {
            type: "twitter_integration_config",
            action: "get",
          } as import("../daemon/ipc-protocol.js").ClientMessage,
          "twitter_integration_config_response",
        );
        const r = daemonResponse as Record<string, unknown>;
        oauthInfo = {
          oauthConnected: r.connected ?? false,
          oauthAccount: r.accountInfo ?? undefined,
          preferredStrategy: r.strategy ?? "auto",
          strategyConfigured: r.strategyConfigured ?? false,
        };
      } catch {
        // Daemon may not be running; report what we can from the local session
        oauthInfo = {
          oauthConnected: undefined,
          oauthAccount: undefined,
          preferredStrategy: undefined,
          strategyConfigured: undefined,
        };
      }

      output(
        {
          ok: true,
          loggedIn: !!session,
          ...browserInfo,
          ...oauthInfo,
        },
        getJson(cmd),
      );
    });

  // =========================================================================
  // strategy — get or set the Twitter operation strategy
  // =========================================================================
  const strategyCli = tw
    .command("strategy")
    .description(
      "Get or set the Twitter operation strategy (oauth, browser, auto)",
    )
    .action(async (_opts: unknown, cmd: Command) => {
      const json = getJson(cmd);
      try {
        const daemonResponse = await sendDaemonMessage(
          {
            type: "twitter_integration_config",
            action: "get_strategy",
          } as import("../daemon/ipc-protocol.js").ClientMessage,
          "twitter_integration_config_response",
        );
        const r = daemonResponse as Record<string, unknown>;
        output({ ok: true, strategy: r.strategy ?? "auto" }, json);
      } catch (err) {
        outputError(err instanceof Error ? err.message : String(err));
      }
    });

  strategyCli
    .command("set")
    .description("Set the Twitter operation strategy")
    .argument("<value>", "Strategy value: oauth, browser, or auto")
    .action(async (value: string, _opts: unknown, cmd: Command) => {
      const json = getJson(cmd);
      try {
        const daemonResponse = await sendDaemonMessage(
          {
            type: "twitter_integration_config",
            action: "set_strategy",
            strategy: value,
          } as import("../daemon/ipc-protocol.js").ClientMessage,
          "twitter_integration_config_response",
        );
        const r = daemonResponse as Record<string, unknown>;
        if (r.success) {
          output({ ok: true, strategy: r.strategy }, json);
        } else {
          output(
            { ok: false, error: r.error ?? "Failed to set strategy" },
            json,
          );
          process.exitCode = 1;
        }
      } catch (err) {
        outputError(err instanceof Error ? err.message : String(err));
      }
    });

  // =========================================================================
  // post — post a tweet
  // =========================================================================
  tw.command("post")
    .description("Post a tweet")
    .argument("<text>", "Tweet text")
    .action(async (text: string, _opts: unknown, cmd: Command) => {
      await run(cmd, async () => {
        const { result, pathUsed } = await routedPostTweet(text);
        return {
          tweetId: result.tweetId,
          text: result.text,
          url: result.url,
          pathUsed,
        };
      });
    });

  // =========================================================================
  // reply — reply to a tweet
  // =========================================================================
  tw.command("reply")
    .description("Reply to a tweet")
    .argument("<tweetUrl>", "Tweet URL or tweet ID")
    .argument("<text>", "Reply text")
    .action(
      async (tweetUrl: string, text: string, _opts: unknown, cmd: Command) => {
        await run(cmd, async () => {
          // Extract tweet ID: either a bare numeric ID or the last numeric segment of a URL
          const idMatch = tweetUrl.match(/(\d+)\s*$/);
          if (!idMatch) {
            throw new Error(`Could not extract tweet ID from: ${tweetUrl}`);
          }
          const inReplyToTweetId = idMatch[1];
          const { result, pathUsed } = await routedPostTweet(text, {
            inReplyToTweetId,
          });
          return {
            tweetId: result.tweetId,
            text: result.text,
            url: result.url,
            inReplyToTweetId,
            pathUsed,
          };
        });
      },
    );
  // =========================================================================
  // timeline — fetch a user's recent tweets
  // =========================================================================
  tw.command("timeline")
    .description("Fetch a user's recent tweets")
    .argument("<screenName>", "Twitter screen name (without @)")
    .option("--count <n>", "Number of tweets to fetch", "20")
    .action(
      async (screenName: string, opts: { count: string }, cmd: Command) => {
        await run(cmd, async () => {
          const user = await getUserByScreenName(screenName.replace(/^@/, ""));
          const tweets = await getUserTweets(
            user.userId,
            parseInt(opts.count, 10),
          );
          return { user, tweets };
        });
      },
    );

  // =========================================================================
  // tweet — fetch a single tweet and its replies
  // =========================================================================
  tw.command("tweet")
    .description("Fetch a tweet and its reply thread")
    .argument("<tweetIdOrUrl>", "Tweet ID or URL")
    .action(async (tweetIdOrUrl: string, _opts: unknown, cmd: Command) => {
      await run(cmd, async () => {
        const idMatch = tweetIdOrUrl.match(/(\d+)\s*$/);
        if (!idMatch)
          throw new Error(`Could not extract tweet ID from: ${tweetIdOrUrl}`);
        const tweets = await getTweetDetail(idMatch[1]);
        return { tweets };
      });
    });

  // =========================================================================
  // search — search tweets
  // =========================================================================
  tw.command("search")
    .description("Search tweets")
    .argument("<query>", "Search query")
    .option("--product <type>", "Top, Latest, People, or Media", "Top")
    .action(async (query: string, opts: { product: string }, cmd: Command) => {
      await run(cmd, async () => {
        const tweets = await searchTweets(
          query,
          opts.product as "Top" | "Latest" | "People" | "Media",
        );
        return { query, tweets };
      });
    });

  // =========================================================================
  // bookmarks — fetch bookmarks
  // =========================================================================
  tw.command("bookmarks")
    .description("Fetch your bookmarks")
    .option("--count <n>", "Number of bookmarks", "20")
    .action(async (opts: { count: string }, cmd: Command) => {
      await run(cmd, async () => {
        const tweets = await getBookmarks(parseInt(opts.count, 10));
        return { tweets };
      });
    });

  // =========================================================================
  // home — fetch home timeline
  // =========================================================================
  tw.command("home")
    .description("Fetch your home timeline")
    .option("--count <n>", "Number of tweets", "20")
    .action(async (opts: { count: string }, cmd: Command) => {
      await run(cmd, async () => {
        const tweets = await getHomeTimeline(parseInt(opts.count, 10));
        return { tweets };
      });
    });

  // =========================================================================
  // notifications — fetch notifications
  // =========================================================================
  tw.command("notifications")
    .description("Fetch your notifications")
    .option("--count <n>", "Number of notifications", "20")
    .action(async (opts: { count: string }, cmd: Command) => {
      await run(cmd, async () => {
        const notifications = await getNotifications(parseInt(opts.count, 10));
        return { notifications };
      });
    });

  // =========================================================================
  // likes — fetch a user's liked tweets
  // =========================================================================
  tw.command("likes")
    .description("Fetch a user's liked tweets")
    .argument("<screenName>", "Twitter screen name (without @)")
    .option("--count <n>", "Number of likes", "20")
    .action(
      async (screenName: string, opts: { count: string }, cmd: Command) => {
        await run(cmd, async () => {
          const user = await getUserByScreenName(screenName.replace(/^@/, ""));
          const tweets = await getLikes(user.userId, parseInt(opts.count, 10));
          return { user, tweets };
        });
      },
    );

  // =========================================================================
  // followers — fetch a user's followers
  // =========================================================================
  tw.command("followers")
    .description("Fetch a user's followers")
    .argument("<screenName>", "Twitter screen name (without @)")
    .action(async (screenName: string, _opts: unknown, cmd: Command) => {
      await run(cmd, async () => {
        const cleanName = screenName.replace(/^@/, "");
        const user = await getUserByScreenName(cleanName);
        const followers = await getFollowers(user.userId, cleanName);
        return { user, followers };
      });
    });

  // =========================================================================
  // following — fetch who a user follows
  // =========================================================================
  tw.command("following")
    .description("Fetch who a user follows")
    .argument("<screenName>", "Twitter screen name (without @)")
    .option("--count <n>", "Number of following", "20")
    .action(
      async (screenName: string, opts: { count: string }, cmd: Command) => {
        await run(cmd, async () => {
          const user = await getUserByScreenName(screenName.replace(/^@/, ""));
          const following = await getFollowing(
            user.userId,
            parseInt(opts.count, 10),
          );
          return { user, following };
        });
      },
    );

  // =========================================================================
  // media — fetch a user's media tweets
  // =========================================================================
  tw.command("media")
    .description("Fetch a user's media tweets")
    .argument("<screenName>", "Twitter screen name (without @)")
    .option("--count <n>", "Number of media tweets", "20")
    .action(
      async (screenName: string, opts: { count: string }, cmd: Command) => {
        await run(cmd, async () => {
          const user = await getUserByScreenName(screenName.replace(/^@/, ""));
          const tweets = await getUserMedia(
            user.userId,
            parseInt(opts.count, 10),
          );
          return { user, tweets };
        });
      },
    );
}

// ---------------------------------------------------------------------------
// Daemon IPC helper — send a message and wait for the first response
// ---------------------------------------------------------------------------

function sendDaemonMessage(
  message: import("../daemon/ipc-protocol.js").ClientMessage,
  expectedResponseType: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socketPath = getSocketPath();
    const sessionToken = readSessionToken();
    const socket = net.createConnection(socketPath);
    const parser = createMessageParser();

    const timeoutHandle = setTimeout(() => {
      socket.destroy();
      reject(new Error("Request timed out after 10s"));
    }, 10_000);
    timeoutHandle.unref();

    let authenticated = !sessionToken;
    let messageSent = false;

    const sendPayload = () => {
      if (messageSent) return;
      messageSent = true;
      socket.write(serialize(message));
    };

    socket.on("error", (err) => {
      clearTimeout(timeoutHandle);
      reject(
        new Error(
          `Cannot connect to assistant: ${err.message}. Is the assistant running?`,
        ),
      );
    });

    socket.on("data", (chunk) => {
      const messages = parser.feed(chunk.toString("utf-8"));
      for (const msg of messages) {
        const m = msg as unknown as Record<string, unknown>;

        if (!authenticated && m.type === "auth_result") {
          if ((m as { success: boolean }).success) {
            authenticated = true;
            sendPayload();
          } else {
            clearTimeout(timeoutHandle);
            socket.destroy();
            reject(new Error("Authentication failed"));
          }
          continue;
        }

        // Reject immediately on daemon error frames so the CLI surfaces the
        // real failure reason instead of hanging until the timeout fires.
        if (m.type === "error") {
          clearTimeout(timeoutHandle);
          socket.destroy();
          reject(
            new Error(
              (m as { message?: string }).message ??
                "Assistant returned an error",
            ),
          );
          return;
        }

        // Only resolve on the expected response type; skip everything else
        if (m.type === expectedResponseType) {
          clearTimeout(timeoutHandle);
          socket.destroy();
          resolve(m);
          return;
        }
        // Skip all other message types (auth_result, daemon_status, pong, session_info, tasks_changed, etc.)
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
        sendPayload();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Chrome CDP helpers (shared)
// ---------------------------------------------------------------------------

import {
  ensureChromeWithCdp,
  minimizeChromeWindow,
} from "../tools/browser/chrome-cdp.js";

// ---------------------------------------------------------------------------
// Ride Shotgun learn session helper
// ---------------------------------------------------------------------------

interface LearnResult {
  recordingId?: string;
  recordingPath?: string;
}

async function navigateToX(cdpBase: string): Promise<void> {
  try {
    const res = await fetch(`${cdpBase}/json/list`);
    if (!res.ok) return;
    const targets = (await res.json()) as Array<{
      id: string;
      type: string;
      url: string;
    }>;
    const tab = targets.find((t) => t.type === "page");
    if (!tab) return;
    await fetch(
      `${cdpBase}/json/navigate?url=${encodeURIComponent(
        "https://x.com/login",
      )}&id=${tab.id}`,
      { method: "PUT" },
    );
  } catch {
    // best-effort
  }
}

async function startLearnSession(
  durationSeconds: number,
): Promise<LearnResult> {
  const cdpSession = await ensureChromeWithCdp({
    startUrl: "https://x.com/login",
  });
  await navigateToX(cdpSession.baseUrl);

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
          targetDomain: "x.com",
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
