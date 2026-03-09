/**
 * CLI command group: `assistant twitter`
 *
 * Post tweets and manage Twitter sessions via the command line.
 * All commands output JSON to stdout. Use --json for machine-readable output.
 */

import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { promisify } from "node:util";

import { Command } from "commander";

const execFileAsync = promisify(execFile);

import { httpSend } from "../../http-client.js";
import { listRecordingFiles } from "../../../tools/browser/recording-store.js";
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
} from "./client.js";
import type { TwitterStrategy } from "./router.js";
import { routedPostTweet } from "./router.js";
import { clearSession, importFromRecording, loadSession } from "./session.js";

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
  "run `assistant twitter refresh` to capture your session automatically.";

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

  tw.addHelpText(
    "after",
    `
Twitter (X) uses a dual-path architecture for interacting with the platform:

  1. OAuth (official API) — uses an authenticated Twitter OAuth application for
     posting and replying. Requires a connected OAuth credential.
  2. Browser session (Ride Shotgun) — uses cookies captured from a real Chrome
     session to call Twitter's internal GraphQL API. Supports all read operations
     and posting as a fallback.

The strategy system controls which path is used for operations that support both:
  oauth    — always use the OAuth API; fail if unavailable
  browser  — always use the browser session; fail if unavailable
  auto     — try OAuth first, fall back to browser session (default)

Session management:
  - "login" imports cookies from a Ride Shotgun recording file
  - "refresh" launches Chrome with CDP, navigates to x.com/login, and runs a
    Ride Shotgun learn session to capture fresh cookies automatically
  - "status" shows whether browser session and OAuth are active
  - "logout" clears the saved browser session cookies

Examples:
  $ assistant x status
  $ assistant x post "Hello world" --strategy auto
  $ assistant x timeline elonmusk --count 10
  $ assistant x search "from:vaborsh AI agents" --product Latest
  $ assistant x strategy set oauth`,
  );

  // =========================================================================
  // login — import session from a recording
  // =========================================================================
  tw.command("login")
    .description("Import a Twitter session from a Ride Shotgun recording")
    .requiredOption("--recording <path>", "Path to the recording JSON file")
    .addHelpText(
      "after",
      `
Imports cookies from a Ride Shotgun recording file to establish a browser
session. The recording file is a JSON file produced by a Ride Shotgun learn
session that contains captured cookies for x.com.

After import, all browser-path commands (timeline, search, bookmarks, etc.)
will use these cookies for authentication.

Examples:
  $ assistant x login --recording /tmp/ride-shotgun/recording-abc123.json
  $ assistant x login --recording ~/recordings/twitter-session.json`,
    )
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
    .addHelpText(
      "after",
      `
Deletes all saved browser session cookies. After logout, browser-path commands
will fail until a new session is imported via "login" or captured via "refresh".
OAuth credentials are not affected.

Examples:
  $ assistant x logout`,
    )
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
    .addHelpText(
      "after",
      `
Restarts Chrome with CDP (Chrome DevTools Protocol) enabled, navigates to
x.com/login, and runs a Ride Shotgun learn session to capture fresh cookies.
Sign in when Chrome opens — the session will be recorded automatically.

The --duration flag sets how long (in seconds) the recording runs before
stopping. Default is 180 seconds (3 minutes). After the recording completes,
cookies are imported automatically and Chrome is minimized.

Requires the assistant to be running (Ride Shotgun runs via the assistant).

Examples:
  $ assistant x refresh
  $ assistant x refresh --duration 120
  $ assistant x refresh --duration 300`,
    )
    .action(async (opts: { duration: string }, cmd: Command) => {
      const json = getJson(cmd);
      const duration = parseInt(opts.duration, 10);

      try {
        const result = await startLearnSession(duration);
        if (result.recordingPath) {
          const session = importFromRecording(result.recordingPath);

          // Hide Chrome after capturing session
          try {
            await minimizeChrome();
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
    .addHelpText(
      "after",
      `
Shows the current state of both authentication paths:

  Browser session — whether cookies are loaded, cookie count, import timestamp,
    and the recording ID they came from.
  OAuth — whether an OAuth credential is connected, the linked account, the
    current strategy setting, and whether a strategy has been explicitly configured.

If the assistant is not running, OAuth fields will be reported as undefined.

Examples:
  $ assistant x status
  $ assistant x status --json`,
    )
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
        const r = await sendTwitterConfigRequest("get");
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
    .addHelpText(
      "after",
      `
The strategy controls which authentication path is used for operations that
support both OAuth and browser session:

  oauth    — always use the official Twitter OAuth API. Fails if no OAuth
             credential is connected. Best for reliable posting.
  browser  — always use the browser session (captured cookies). Fails if no
             session is loaded. Required for read-only endpoints not available
             via OAuth (bookmarks, notifications, search).
  auto     — try OAuth first, fall back to browser session. This is the default.

Run without a subcommand to display the current strategy. Use "set" to change it.

Examples:
  $ assistant x strategy
  $ assistant x strategy set oauth
  $ assistant x strategy set auto`,
    )
    .action(async (_opts: unknown, cmd: Command) => {
      const json = getJson(cmd);
      try {
        const r = await sendTwitterConfigRequest("get_strategy");
        output({ ok: true, strategy: r.strategy ?? "auto" }, json);
      } catch (err) {
        outputError(err instanceof Error ? err.message : String(err));
      }
    });

  strategyCli
    .command("set")
    .description("Set the Twitter operation strategy")
    .argument("<value>", "Strategy value: oauth, browser, or auto")
    .addHelpText(
      "after",
      `
Arguments:
  value   Strategy to use: "oauth", "browser", or "auto"

Sets the preferred strategy for Twitter operations that support dual-path
routing. The setting is persisted by the assistant and applies to all subsequent
operations until changed.

Examples:
  $ assistant x strategy set oauth
  $ assistant x strategy set browser
  $ assistant x strategy set auto`,
    )
    .action(async (value: string, _opts: unknown, cmd: Command) => {
      const json = getJson(cmd);
      try {
        const r = await sendTwitterConfigRequest("set_strategy", { strategy: value });
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
    .requiredOption(
      "--strategy <strategy>",
      "Operation strategy: oauth, browser, or auto",
    )
    .option(
      "--oauth-token <token>",
      "OAuth access token (required when strategy is oauth or auto)",
    )
    .addHelpText(
      "after",
      `
Arguments:
  text   The tweet text to post (max 280 characters)

Posts a new tweet using the routed dual-path system. The --strategy flag
controls which path is used. The response includes the tweet ID, URL, and
which path was used.

Examples:
  $ assistant x post "Hello world" --strategy browser
  $ assistant x post "Hello world" --strategy oauth --oauth-token "$TOKEN"
  $ assistant x post "Hello world" --strategy auto --oauth-token "$TOKEN"`,
    )
    .action(
      async (
        text: string,
        opts: { strategy: string; oauthToken?: string },
        cmd: Command,
      ) => {
        await run(cmd, async () => {
          const strategy = opts.strategy as TwitterStrategy;
          if (
            strategy !== "oauth" &&
            strategy !== "browser" &&
            strategy !== "auto"
          ) {
            throw new Error(
              `Invalid strategy "${opts.strategy}". Must be oauth, browser, or auto.`,
            );
          }
          const { result, pathUsed } = await routedPostTweet(text, {
            strategy,
            oauthToken: opts.oauthToken,
          });
          return {
            tweetId: result.tweetId,
            text: result.text,
            url: result.url,
            pathUsed,
          };
        });
      },
    );

  // =========================================================================
  // reply — reply to a tweet
  // =========================================================================
  tw.command("reply")
    .description("Reply to a tweet")
    .argument("<tweetUrl>", "Tweet URL or tweet ID")
    .argument("<text>", "Reply text")
    .requiredOption(
      "--strategy <strategy>",
      "Operation strategy: oauth, browser, or auto",
    )
    .option(
      "--oauth-token <token>",
      "OAuth access token (required when strategy is oauth or auto)",
    )
    .addHelpText(
      "after",
      `
Arguments:
  tweetUrl   Full tweet URL (e.g. https://x.com/user/status/123456) or a bare tweet ID
  text       The reply text to post (max 280 characters)

Posts a reply to the specified tweet. Accepts either a full tweet URL or a bare
numeric tweet ID. The tweet ID is extracted from the last numeric segment of the
URL. The --strategy flag controls which path is used.

Examples:
  $ assistant x reply https://x.com/elonmusk/status/1234567890 "Great point!" --strategy browser
  $ assistant x reply 1234567890 "Interesting thread" --strategy oauth --oauth-token "$TOKEN"`,
    )
    .action(
      async (
        tweetUrl: string,
        text: string,
        opts: { strategy: string; oauthToken?: string },
        cmd: Command,
      ) => {
        await run(cmd, async () => {
          const strategy = opts.strategy as TwitterStrategy;
          if (
            strategy !== "oauth" &&
            strategy !== "browser" &&
            strategy !== "auto"
          ) {
            throw new Error(
              `Invalid strategy "${opts.strategy}". Must be oauth, browser, or auto.`,
            );
          }
          // Extract tweet ID: either a bare numeric ID or the last numeric segment of a URL
          const idMatch = tweetUrl.match(/(\d+)\s*$/);
          if (!idMatch) {
            throw new Error(`Could not extract tweet ID from: ${tweetUrl}`);
          }
          const inReplyToTweetId = idMatch[1];
          const { result, pathUsed } = await routedPostTweet(text, {
            inReplyToTweetId,
            strategy,
            oauthToken: opts.oauthToken,
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
    .addHelpText(
      "after",
      `
Arguments:
  screenName   Twitter screen name without the @ prefix (e.g. "elonmusk", not "@elonmusk")

Fetches a user's recent tweets via the browser session. Resolves the screen name
to a user ID first, then retrieves their tweet timeline. The --count flag controls
how many tweets to return (default: 20).

Examples:
  $ assistant x timeline elonmusk
  $ assistant x timeline vaborsh --count 50
  $ assistant x timeline openai --count 10 --json`,
    )
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
    .addHelpText(
      "after",
      `
Arguments:
  tweetIdOrUrl   A bare tweet ID (e.g. 1234567890) or a full tweet URL
                 (e.g. https://x.com/user/status/1234567890)

Fetches a single tweet and its reply thread via the browser session. The tweet
ID is extracted from the last numeric segment of the input. Returns an array of
tweets representing the conversation thread.

Examples:
  $ assistant x tweet 1234567890
  $ assistant x tweet https://x.com/elonmusk/status/1234567890
  $ assistant x tweet https://x.com/openai/status/9876543210 --json`,
    )
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
    .addHelpText(
      "after",
      `
Arguments:
  query   Twitter search query string. Supports Twitter search operators
          (e.g. "from:user", "to:user", "min_faves:100", quoted phrases)

The --product flag selects the search result type:
  Top      — most relevant tweets (default)
  Latest   — most recent tweets, reverse chronological
  People   — user accounts matching the query
  Media    — tweets containing images or video

Uses the browser session path. Requires an active browser session.

Examples:
  $ assistant x search "AI agents"
  $ assistant x search "from:elonmusk SpaceX" --product Latest
  $ assistant x search "machine learning" --product Media --json`,
    )
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
    .addHelpText(
      "after",
      `
Fetches the authenticated user's bookmarked tweets via the browser session.
The --count flag controls how many bookmarks to return (default: 20).

Requires an active browser session. Bookmarks are private and only available
for the logged-in account.

Examples:
  $ assistant x bookmarks
  $ assistant x bookmarks --count 50
  $ assistant x bookmarks --json`,
    )
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
    .addHelpText(
      "after",
      `
Fetches the authenticated user's home timeline (the "For You" feed) via the
browser session. The --count flag controls how many tweets to return (default: 20).

Requires an active browser session.

Examples:
  $ assistant x home
  $ assistant x home --count 50
  $ assistant x home --json`,
    )
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
    .addHelpText(
      "after",
      `
Fetches the authenticated user's Twitter notifications (mentions, likes,
retweets, follows, etc.) via the browser session. The --count flag controls
how many notifications to return (default: 20).

Requires an active browser session.

Examples:
  $ assistant x notifications
  $ assistant x notifications --count 50
  $ assistant x notifications --json`,
    )
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
    .addHelpText(
      "after",
      `
Arguments:
  screenName   Twitter screen name without the @ prefix (e.g. "elonmusk", not "@elonmusk")

Fetches tweets liked by the specified user via the browser session. Resolves the
screen name to a user ID first. The --count flag controls how many liked tweets
to return (default: 20).

Examples:
  $ assistant x likes elonmusk
  $ assistant x likes vaborsh --count 50
  $ assistant x likes openai --json`,
    )
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
    .addHelpText(
      "after",
      `
Arguments:
  screenName   Twitter screen name without the @ prefix (e.g. "elonmusk", not "@elonmusk")

Fetches the list of accounts following the specified user via the browser session.
Resolves the screen name to a user ID first.

Examples:
  $ assistant x followers elonmusk
  $ assistant x followers vaborsh --json`,
    )
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
    .addHelpText(
      "after",
      `
Arguments:
  screenName   Twitter screen name without the @ prefix (e.g. "elonmusk", not "@elonmusk")

Fetches the list of accounts the specified user follows via the browser session.
Resolves the screen name to a user ID first. The --count flag controls how many
results to return (default: 20).

Examples:
  $ assistant x following elonmusk
  $ assistant x following vaborsh --count 100
  $ assistant x following openai --json`,
    )
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
    .addHelpText(
      "after",
      `
Arguments:
  screenName   Twitter screen name without the @ prefix (e.g. "elonmusk", not "@elonmusk")

Fetches tweets containing images or video from the specified user via the browser
session. Resolves the screen name to a user ID first. The --count flag controls
how many media tweets to return (default: 20).

Examples:
  $ assistant x media elonmusk
  $ assistant x media nasa --count 50
  $ assistant x media openai --json`,
    )
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
// Daemon HTTP helper — send requests to the daemon's HTTP API
// ---------------------------------------------------------------------------

/**
 * Send a Twitter integration config request to the daemon via HTTP.
 *
 * Maps the old IPC `twitter_integration_config` message actions to HTTP
 * endpoints on the settings routes:
 *   - "get" / "get_strategy" → GET /v1/integrations/twitter/auth/status
 *   - "set_strategy"         → PUT /v1/settings/client (key=twitter.strategy)
 */
async function sendTwitterConfigRequest(
  action: string,
  extra?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (action === "get" || action === "get_strategy") {
    const response = await httpSend("/v1/integrations/twitter/auth/status", {
      method: "GET",
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Assistant returned an error: ${text}`);
    }
    const data = (await response.json()) as Record<string, unknown>;
    // Map the HTTP response shape to the old IPC response shape
    return {
      type: "twitter_integration_config_response",
      success: true,
      connected: data.connected ?? false,
      accountInfo: data.accountInfo,
      strategy: data.strategy ?? "auto",
      strategyConfigured: data.strategyConfigured ?? false,
      mode: data.mode,
    };
  }

  if (action === "set_strategy") {
    const strategy = extra?.strategy as string | undefined;
    if (!strategy) throw new Error("strategy is required for set_strategy");
    const response = await httpSend("/v1/settings/client", {
      method: "PUT",
      body: JSON.stringify({ key: "twitter.strategy", value: strategy }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Assistant returned an error: ${text}`);
    }
    return {
      type: "twitter_integration_config_response",
      success: true,
      strategy,
    };
  }

  throw new Error(`Unsupported twitter_integration_config action: ${action}`);
}

// ---------------------------------------------------------------------------
// Chrome CDP helpers (via `assistant browser chrome` CLI)
// ---------------------------------------------------------------------------

async function launchChromeCdp(
  startUrl?: string,
): Promise<{ baseUrl: string }> {
  const args = ["browser", "chrome", "launch"];
  if (startUrl) args.push("--start-url", startUrl);
  const { stdout } = await execFileAsync("assistant", args);
  const result = JSON.parse(stdout) as {
    ok: boolean;
    baseUrl?: string;
    error?: string;
  };
  if (!result.ok || !result.baseUrl) {
    throw new Error(result.error ?? "Failed to launch Chrome with CDP");
  }
  return { baseUrl: result.baseUrl };
}

async function minimizeChrome(): Promise<void> {
  try {
    await execFileAsync("assistant", ["browser", "chrome", "minimize"]);
  } catch {
    // best-effort — same as the original
  }
}

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
  const cdpSession = await launchChromeCdp("https://x.com/login");
  await navigateToX(cdpSession.baseUrl);

  // Snapshot existing recordings so we can detect new ones after the session
  const existingRecordings = new Set(listRecordingFiles());

  // Start ride shotgun via HTTP
  const response = await httpSend("/v1/computer-use/ride-shotgun/start", {
    method: "POST",
    body: JSON.stringify({
      durationSeconds,
      intervalSeconds: 5,
      mode: "learn",
      targetDomain: "x.com",
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Cannot connect to assistant: ${response.status} ${body}. Is the assistant running?`,
    );
  }

  const startResult = (await response.json()) as {
    watchId?: string;
    sessionId?: string;
  };

  if (!startResult.watchId) {
    throw new Error("Ride-shotgun start response missing watchId");
  }

  // Poll for a new recording file to appear after the session completes
  const timeoutMs = (durationSeconds + 30) * 1000;
  const pollIntervalMs = 2000;
  const startTime = Date.now();

  return new Promise<LearnResult>((resolve, reject) => {
    const poll = setInterval(() => {
      if (Date.now() - startTime > timeoutMs) {
        clearInterval(poll);
        reject(
          new Error(`Learn session timed out after ${durationSeconds + 30}s`),
        );
        return;
      }

      const currentRecordings = listRecordingFiles();
      for (const filePath of currentRecordings) {
        if (existingRecordings.has(filePath)) continue;

        try {
          const stat = statSync(filePath);
          if (stat.mtimeMs >= startTime - 1000) {
            clearInterval(poll);
            const filename = filePath.split("/").pop() ?? "";
            const recordingId = filename.replace(/\.json$/, "");
            resolve({ recordingId, recordingPath: filePath });
            return;
          }
        } catch {
          // File may have been deleted between readdir and stat
        }
      }
    }, pollIntervalMs);
  });
}
