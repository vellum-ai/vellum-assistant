#!/usr/bin/env bun
/**
 * CLI for Twitter/X skill: `bun run scripts/twitter-cli.ts`
 *
 * Provides read/write access to X (formerly Twitter) via OAuth or browser session.
 * Outputs structured JSON data that can be presented in any environment.
 */

import type { TwitterCommand } from "./service.js";
import { executeTwitterCommand } from "./service.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function output(data: unknown): void {
  process.stdout.write(JSON.stringify(data) + "\n");
}

function outputError(message: string, code = 1): void {
  output({ ok: false, error: message });
  process.exitCode = code;
}

function printUsage(): void {
  process.stderr
    .write(`Usage: bun run scripts/twitter-cli.ts <command> [options]

Interact with X (formerly Twitter) via OAuth or browser session.

Commands:
  status                     Check connection status
  post <text>                Post a new tweet
  reply <tweetUrl> <text>    Reply to a tweet
  timeline <screenName>      Get user's timeline
  tweet <tweetIdOrUrl>       Get a tweet and its replies
  search <query>             Search for tweets
  bookmarks                  Get your bookmarks
  home                       Get your home timeline
  notifications              Get your notifications
  likes <screenName>         Get user's likes
  followers <screenName>     Get user's followers
  following <screenName>     Get accounts user follows
  media <screenName>         Get user's media tweets
  login                      Initiate OAuth login flow
  logout                     Log out of current session
  refresh                    Refresh browser session cookies
  strategy [get|set <value>] Get or set the connection strategy (oauth|browser|auto)

Options:
  --count <n>                Number of items to fetch (default varies by command)
  --product <type>           Search product type: Top, Latest, People, Media
  --json                     Output raw JSON (status command)
  --help, -h                 Show this help message

Output:
  Returns JSON with { ok, ... } where ok indicates success.

Examples:
  bun run scripts/twitter-cli.ts status --json
  bun run scripts/twitter-cli.ts post "Hello, world!"
  bun run scripts/twitter-cli.ts reply https://x.com/user/status/123 "Nice post!"
  bun run scripts/twitter-cli.ts timeline elonmusk --count 10
  bun run scripts/twitter-cli.ts search "bun runtime" --product Latest --count 20
  bun run scripts/twitter-cli.ts strategy set oauth
`);
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  command: TwitterCommand | null;
  args: string[];
  options: {
    count?: number;
    product?: "Top" | "Latest" | "People" | "Media";
    json?: boolean;
    help: boolean;
  };
}

const VALID_COMMANDS: TwitterCommand[] = [
  "status",
  "post",
  "reply",
  "timeline",
  "tweet",
  "search",
  "bookmarks",
  "home",
  "notifications",
  "likes",
  "followers",
  "following",
  "media",
  "login",
  "logout",
  "refresh",
  "strategy",
];

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    command: null,
    args: [],
    options: { help: false },
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      result.options.help = true;
      i++;
    } else if (arg === "--json") {
      result.options.json = true;
      i++;
    } else if (arg === "--count" && i + 1 < argv.length) {
      const val = parseInt(argv[i + 1], 10);
      if (isNaN(val) || val < 1) {
        outputError("Invalid count. Must be a positive integer.");
        process.exit(1);
      }
      result.options.count = val;
      i += 2;
    } else if (arg === "--product" && i + 1 < argv.length) {
      const val = argv[i + 1];
      if (!["Top", "Latest", "People", "Media"].includes(val)) {
        outputError(
          'Invalid product type. Use "Top", "Latest", "People", or "Media".',
        );
        process.exit(1);
      }
      result.options.product = val as "Top" | "Latest" | "People" | "Media";
      i += 2;
    } else if (!arg.startsWith("-")) {
      if (result.command === null) {
        if (VALID_COMMANDS.includes(arg as TwitterCommand)) {
          result.command = arg as TwitterCommand;
        } else {
          outputError(`Unknown command: ${arg}`);
          printUsage();
          process.exit(1);
        }
      } else {
        result.args.push(arg);
      }
      i++;
    } else {
      outputError(`Unknown option: ${arg}`);
      process.exit(1);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

function buildInput(
  command: TwitterCommand,
  args: string[],
  options: ParsedArgs["options"],
): Record<string, unknown> {
  switch (command) {
    case "status":
      return { json: options.json };

    case "post":
      if (args.length < 1) {
        outputError("post requires text argument");
        process.exit(1);
      }
      return { text: args[0] };

    case "reply":
      if (args.length < 2) {
        outputError("reply requires tweetUrl and text arguments");
        process.exit(1);
      }
      return { tweetUrl: args[0], text: args[1] };

    case "timeline":
      if (args.length < 1) {
        outputError("timeline requires screenName argument");
        process.exit(1);
      }
      return { screenName: args[0], count: options.count };

    case "tweet":
      if (args.length < 1) {
        outputError("tweet requires tweetIdOrUrl argument");
        process.exit(1);
      }
      return { tweetIdOrUrl: args[0] };

    case "search":
      if (args.length < 1) {
        outputError("search requires query argument");
        process.exit(1);
      }
      return { query: args[0], count: options.count, product: options.product };

    case "bookmarks":
      return { count: options.count };

    case "home":
      return { count: options.count };

    case "notifications":
      return { count: options.count };

    case "likes":
      if (args.length < 1) {
        outputError("likes requires screenName argument");
        process.exit(1);
      }
      return { screenName: args[0], count: options.count };

    case "followers":
      if (args.length < 1) {
        outputError("followers requires screenName argument");
        process.exit(1);
      }
      return { screenName: args[0], count: options.count };

    case "following":
      if (args.length < 1) {
        outputError("following requires screenName argument");
        process.exit(1);
      }
      return { screenName: args[0], count: options.count };

    case "media":
      if (args.length < 1) {
        outputError("media requires screenName argument");
        process.exit(1);
      }
      return { screenName: args[0], count: options.count };

    case "strategy":
      if (args.length === 0) {
        return { action: "get" };
      }
      if (args[0] === "get") {
        return { action: "get" };
      }
      if (args[0] === "set") {
        if (args.length < 2) {
          outputError(
            "strategy set requires a value (oauth, browser, or auto)",
          );
          process.exit(1);
        }
        const value = args[1];
        if (!["oauth", "browser", "auto"].includes(value)) {
          outputError(
            'Invalid strategy value. Use "oauth", "browser", or "auto".',
          );
          process.exit(1);
        }
        return { action: "set", value };
      }
      outputError('Invalid strategy action. Use "get" or "set".');
      process.exit(1);
      break;

    case "login":
    case "logout":
    case "refresh":
      return {};

    default:
      return {};
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.length === 0) {
    printUsage();
    process.exit(1);
  }

  const parsed = parseArgs(argv);

  if (parsed.options.help) {
    printUsage();
    process.exit(0);
  }

  if (!parsed.command) {
    outputError("No command specified");
    printUsage();
    process.exit(1);
  }

  const input = buildInput(parsed.command, parsed.args, parsed.options);

  try {
    const result = await executeTwitterCommand(parsed.command, input);

    if (result.isError) {
      const data = JSON.parse(result.content);
      output(data);
      process.exitCode = 1;
    } else {
      const data = JSON.parse(result.content);
      output(data);
    }
  } catch (err) {
    outputError(err instanceof Error ? err.message : String(err));
  }
}

main();
