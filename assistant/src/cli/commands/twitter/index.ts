/**
 * CLI command group: `assistant twitter`
 *
 * Post tweets and interact with X via the command line.
 * All commands output JSON to stdout. Use --json for machine-readable output.
 */

import { Command } from "commander";

import { httpSend } from "../../http-client.js";
import type { TwitterMode } from "./router.js";
import {
  routedGetTweetDetail,
  routedGetUserByScreenName,
  routedGetUserTweets,
  routedPostTweet,
  routedSearchTweets,
} from "./router.js";

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

async function run(cmd: Command, fn: () => Promise<unknown>): Promise<void> {
  try {
    const result = await fn();
    output({ ok: true, ...(result as Record<string, unknown>) }, getJson(cmd));
  } catch (err) {
    const meta = err as Record<string, unknown>;
    // For routed errors with managed-path metadata, emit structured JSON
    if (err instanceof Error && meta.proxyErrorCode !== undefined) {
      const payload: Record<string, unknown> = {
        ok: false,
        error: err.message,
      };
      payload.proxyErrorCode = meta.proxyErrorCode;
      if (meta.retryable !== undefined) payload.retryable = meta.retryable;
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
      "Post on X and manage connections. Supports managed (platform proxy) and OAuth (official API) paths.",
    )
    .option("--json", "Machine-readable JSON output");

  tw.addHelpText(
    "after",
    `
Twitter (X) supports two paths for interacting with the platform:

  1. Managed (platform proxy) — routes Twitter API calls through the platform,
     which holds the OAuth credentials. Used when integrationMode is "managed".
  2. OAuth (official API) — uses an authenticated Twitter OAuth application for
     posting and replying. Requires a connected OAuth credential.

Write operations (post, reply) default to OAuth. Pass --managed to route
through the platform proxy instead. Read operations (timeline, tweet, search)
always use managed mode.

Examples:
  $ assistant x status
  $ assistant x post "Hello world" --managed
  $ assistant x post "Hello world" --oauth-token "$TOKEN"
  $ assistant x timeline elonmusk --count 10
  $ assistant x search "from:vaborsh AI agents" --product Latest`,
  );

  // =========================================================================
  // status — check OAuth and managed mode info
  // =========================================================================
  tw.command("status")
    .description("Check Twitter OAuth and managed mode status")
    .addHelpText(
      "after",
      `
Shows the current state of authentication:

  OAuth — whether an OAuth credential is connected and the linked account.
  Managed — whether managed mode is available and prerequisite status.

If the assistant is not running, fields will be reported as undefined.

Examples:
  $ assistant x status
  $ assistant x status --json`,
    )
    .action(async (_opts: unknown, cmd: Command) => {
      // Query daemon for OAuth / managed config
      let oauthInfo: Record<string, unknown> = {};
      try {
        const r = await sendTwitterConfigRequest("get");
        oauthInfo = {
          oauthConnected: r.connected ?? false,
          oauthAccount: r.accountInfo ?? undefined,
          managedAvailable: r.managedAvailable ?? false,
          managedPrerequisites: r.managedPrerequisites ?? undefined,
          localClientConfigured: r.localClientConfigured ?? false,
        };
      } catch {
        // Daemon may not be running; report what we can
        oauthInfo = {
          oauthConnected: undefined,
          oauthAccount: undefined,
          managedAvailable: undefined,
          managedPrerequisites: undefined,
          localClientConfigured: undefined,
        };
      }

      output(
        {
          ok: true,
          ...oauthInfo,
        },
        getJson(cmd),
      );
    });

  // =========================================================================
  // post — post a tweet
  // =========================================================================
  tw.command("post")
    .description("Post a tweet")
    .argument("<text>", "Tweet text")
    .option("--managed", "Route through the platform proxy (managed mode)")
    .option(
      "--oauth-token <token>",
      "OAuth access token (required for OAuth path)",
    )
    .addHelpText(
      "after",
      `
Arguments:
  text   The tweet text to post (max 280 characters)

Posts a new tweet. By default uses OAuth mode. Pass --managed to route through
the platform proxy instead. The response includes the tweet ID, URL, and which
path was used.

Examples:
  $ assistant x post "Hello world"
  $ assistant x post "Hello world" --oauth-token "$TOKEN"
  $ assistant x post "Hello world" --managed`,
    )
    .action(
      async (
        text: string,
        opts: { managed?: boolean; oauthToken?: string },
        cmd: Command,
      ) => {
        await run(cmd, async () => {
          const mode: TwitterMode = opts.managed ? "managed" : "oauth";
          const { result, pathUsed } = await routedPostTweet(text, {
            mode,
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
    .option("--managed", "Route through the platform proxy (managed mode)")
    .option(
      "--oauth-token <token>",
      "OAuth access token (required for OAuth path)",
    )
    .addHelpText(
      "after",
      `
Arguments:
  tweetUrl   Full tweet URL (e.g. https://x.com/user/status/123456) or a bare tweet ID
  text       The reply text to post (max 280 characters)

Posts a reply to the specified tweet. Accepts either a full tweet URL or a bare
numeric tweet ID. The tweet ID is extracted from the last numeric segment of the
URL. By default uses OAuth mode. Pass --managed to route through the platform proxy.

Examples:
  $ assistant x reply https://x.com/elonmusk/status/1234567890 "Great point!"
  $ assistant x reply 1234567890 "Interesting thread" --oauth-token "$TOKEN"
  $ assistant x reply 1234567890 "Nice!" --managed`,
    )
    .action(
      async (
        tweetUrl: string,
        text: string,
        opts: { managed?: boolean; oauthToken?: string },
        cmd: Command,
      ) => {
        await run(cmd, async () => {
          const mode: TwitterMode = opts.managed ? "managed" : "oauth";
          // Extract tweet ID: either a bare numeric ID or the last numeric segment of a URL
          const idMatch = tweetUrl.match(/(\d+)\s*$/);
          if (!idMatch) {
            throw new Error(`Could not extract tweet ID from: ${tweetUrl}`);
          }
          const inReplyToTweetId = idMatch[1];
          const { result, pathUsed } = await routedPostTweet(text, {
            inReplyToTweetId,
            mode,
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

Fetches a user's recent tweets via managed mode. Resolves the screen name to a
user ID first, then retrieves their tweet timeline. The --count flag controls
how many tweets to return (default: 20).

Examples:
  $ assistant x timeline elonmusk
  $ assistant x timeline vaborsh --count 50
  $ assistant x timeline openai --count 10 --json`,
    )
    .action(
      async (screenName: string, opts: { count: string }, cmd: Command) => {
        await run(cmd, async () => {
          const mode: TwitterMode = "managed";
          const { result: user, pathUsed } = await routedGetUserByScreenName(
            screenName.replace(/^@/, ""),
            { mode },
          );
          const { result: tweets } = await routedGetUserTweets(
            user.userId,
            parseInt(opts.count, 10),
            { mode },
          );
          return { user, tweets, pathUsed };
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

Fetches a single tweet and its reply thread via managed mode. The tweet ID is
extracted from the last numeric segment of the input. Returns an array of tweets
representing the conversation thread.

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
        const mode: TwitterMode = "managed";
        const { result: tweets, pathUsed } = await routedGetTweetDetail(
          idMatch[1],
          { mode },
        );
        return { tweets, pathUsed };
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

Examples:
  $ assistant x search "AI agents"
  $ assistant x search "from:elonmusk SpaceX" --product Latest
  $ assistant x search "machine learning" --product Media --json`,
    )
    .action(async (query: string, opts: { product: string }, cmd: Command) => {
      await run(cmd, async () => {
        const mode: TwitterMode = "managed";
        const product = opts.product as "Top" | "Latest" | "People" | "Media";
        const { result: tweets, pathUsed } = await routedSearchTweets(
          query,
          product,
          { mode },
        );
        return { query, tweets, pathUsed };
      });
    });
}

// ---------------------------------------------------------------------------
// Daemon HTTP helper — send requests to the daemon's HTTP API
// ---------------------------------------------------------------------------

/**
 * Send a Twitter integration config request to the daemon via HTTP.
 *
 * Maps the "get" action to HTTP:
 *   - "get" → GET /v1/integrations/twitter/auth/status
 */
async function sendTwitterConfigRequest(
  action: string,
): Promise<Record<string, unknown>> {
  if (action === "get") {
    const response = await httpSend("/v1/integrations/twitter/auth/status", {
      method: "GET",
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Assistant returned an error: ${text}`);
    }
    const data = (await response.json()) as Record<string, unknown>;
    return {
      type: "twitter_integration_config_response",
      success: true,
      connected: data.connected ?? false,
      accountInfo: data.accountInfo,
      mode: data.mode,
      managedAvailable: data.managedAvailable ?? false,
      managedPrerequisites: data.managedPrerequisites,
      localClientConfigured: data.localClientConfigured ?? false,
    };
  }

  throw new Error(`Unsupported twitter_integration_config action: ${action}`);
}
