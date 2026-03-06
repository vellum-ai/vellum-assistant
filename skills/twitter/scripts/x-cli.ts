#!/usr/bin/env bun
/**
 * CLI for Twitter (X) skill: `bun run scripts/x-cli.ts`
 *
 * Post tweets, manage sessions, and interact with Twitter via the command line.
 * Supports OAuth (official API) and browser session paths.
 * All commands output JSON to stdout.
 */

import {
  getBookmarksService,
  getFollowersService,
  getFollowingService,
  getHome,
  getLikesService,
  getMediaService,
  getNotificationsService,
  getStatus,
  getStrategy,
  getTimeline,
  getTweet,
  login,
  logout,
  post,
  refresh,
  reply,
  search,
  setStrategy,
  SESSION_EXPIRED_MSG,
} from "./service.js";

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
  process.stderr.write(`Usage: bun run scripts/x-cli.ts <command> [arguments] [options]

Post on X and manage connections. Supports OAuth (official API) and browser session paths.

Commands:
  status                        Check session and OAuth status
  login --recording <path>      Import session from recording
  logout                        Clear session
  refresh [--duration N]        Start Ride Shotgun to capture cookies (default: 180s)
  strategy                      Get current strategy
  strategy set <value>          Set strategy (oauth, browser, auto)
  post <text>                   Post a tweet
  reply <tweetUrl> <text>       Reply to a tweet
  timeline <screenName> [--count N]    Get user timeline (default: 20)
  tweet <tweetIdOrUrl>          Get single tweet with replies
  search <query> [--product Top|Latest|People|Media]  Search tweets
  bookmarks [--count N]         Get bookmarks (default: 20)
  home [--count N]              Get home timeline (default: 20)
  notifications [--count N]     Get notifications (default: 20)
  likes <screenName> [--count N]       Get user likes (default: 20)
  followers <screenName>        Get followers
  following <screenName> [--count N]   Get following (default: 20)
  media <screenName> [--count N]       Get user media (default: 20)

Options:
  --help, -h                    Show this help message

Twitter (X) uses a dual-path architecture:
  1. OAuth (official API) - uses authenticated Twitter OAuth application
  2. Browser session (Ride Shotgun) - uses cookies captured from Chrome

Strategy options (oauth, browser, auto):
  oauth    - always use OAuth API; fail if unavailable
  browser  - always use browser session; fail if unavailable
  auto     - try OAuth first, fall back to browser (default)

Examples:
  bun run scripts/x-cli.ts status
  bun run scripts/x-cli.ts post "Hello world"
  bun run scripts/x-cli.ts timeline elonmusk --count 10
  bun run scripts/x-cli.ts search "from:vaborsh AI agents" --product Latest
  bun run scripts/x-cli.ts strategy set oauth
`);
}

// ---------------------------------------------------------------------------
// Argument parsing helpers
// ---------------------------------------------------------------------------

function parseCountOption(args: string[], defaultValue: number = 20): number {
  const countIndex = args.indexOf("--count");
  if (countIndex !== -1 && countIndex + 1 < args.length) {
    const count = parseInt(args[countIndex + 1], 10);
    if (!isNaN(count) && count > 0) {
      return count;
    }
  }
  return defaultValue;
}

function parseDurationOption(args: string[], defaultValue: number = 180): number {
  const durationIndex = args.indexOf("--duration");
  if (durationIndex !== -1 && durationIndex + 1 < args.length) {
    const duration = parseInt(args[durationIndex + 1], 10);
    if (!isNaN(duration) && duration > 0) {
      return duration;
    }
  }
  return defaultValue;
}

function parseProductOption(args: string[]): "Top" | "Latest" | "People" | "Media" {
  const productIndex = args.indexOf("--product");
  if (productIndex !== -1 && productIndex + 1 < args.length) {
    const product = args[productIndex + 1];
    if (product === "Top" || product === "Latest" || product === "People" || product === "Media") {
      return product;
    }
  }
  return "Top";
}

function parseRecordingOption(args: string[]): string | null {
  const recordingIndex = args.indexOf("--recording");
  if (recordingIndex !== -1 && recordingIndex + 1 < args.length) {
    return args[recordingIndex + 1];
  }
  return null;
}

function getPositionalArg(args: string[], index: number): string | undefined {
  // Filter out option flags and their values
  const positional: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--count" || arg === "--duration" || arg === "--product" || arg === "--recording") {
      i += 2; // skip flag and value
    } else if (arg.startsWith("-")) {
      i += 1; // skip standalone flag
    } else {
      positional.push(arg);
      i += 1;
    }
  }
  return positional[index];
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function handleStatus(): Promise<void> {
  const result = await getStatus();
  output(result);
  if (!result.ok) process.exitCode = 1;
}

async function handleLogin(args: string[]): Promise<void> {
  const recordingPath = parseRecordingOption(args);
  if (!recordingPath) {
    outputError("Missing required option: --recording <path>");
    return;
  }
  const result = login(recordingPath);
  output(result);
  if (!result.ok) process.exitCode = 1;
}

function handleLogout(): void {
  const result = logout();
  output(result);
  if (!result.ok) process.exitCode = 1;
}

async function handleRefresh(args: string[]): Promise<void> {
  const duration = parseDurationOption(args);
  const result = await refresh(duration);
  output(result);
  if (!result.ok) process.exitCode = 1;
}

async function handleStrategy(args: string[]): Promise<void> {
  const subcommand = getPositionalArg(args, 0);

  if (subcommand === "set") {
    const value = getPositionalArg(args, 1);
    if (!value) {
      outputError("Missing strategy value. Use: oauth, browser, or auto");
      return;
    }
    if (value !== "oauth" && value !== "browser" && value !== "auto") {
      outputError("Invalid strategy value. Use: oauth, browser, or auto");
      return;
    }
    const result = await setStrategy(value);
    output(result);
    if (!result.ok) process.exitCode = 1;
  } else {
    const result = await getStrategy();
    output(result);
    if (!result.ok) process.exitCode = 1;
  }
}

async function handlePost(args: string[]): Promise<void> {
  const text = getPositionalArg(args, 0);
  if (!text) {
    outputError("Missing required argument: <text>");
    return;
  }
  const result = await post(text);
  output(result);
  if (!result.ok) process.exitCode = 1;
}

async function handleReply(args: string[]): Promise<void> {
  const tweetUrl = getPositionalArg(args, 0);
  const text = getPositionalArg(args, 1);
  if (!tweetUrl) {
    outputError("Missing required argument: <tweetUrl>");
    return;
  }
  if (!text) {
    outputError("Missing required argument: <text>");
    return;
  }
  const result = await reply(tweetUrl, text);
  output(result);
  if (!result.ok) process.exitCode = 1;
}

async function handleTimeline(args: string[]): Promise<void> {
  const screenName = getPositionalArg(args, 0);
  if (!screenName) {
    outputError("Missing required argument: <screenName>");
    return;
  }
  const count = parseCountOption(args);
  const result = await getTimeline(screenName, count);
  output(result);
  if (!result.ok) process.exitCode = 1;
}

async function handleTweet(args: string[]): Promise<void> {
  const tweetIdOrUrl = getPositionalArg(args, 0);
  if (!tweetIdOrUrl) {
    outputError("Missing required argument: <tweetIdOrUrl>");
    return;
  }
  const result = await getTweet(tweetIdOrUrl);
  output(result);
  if (!result.ok) process.exitCode = 1;
}

async function handleSearch(args: string[]): Promise<void> {
  const query = getPositionalArg(args, 0);
  if (!query) {
    outputError("Missing required argument: <query>");
    return;
  }
  const product = parseProductOption(args);
  const result = await search(query, product);
  output(result);
  if (!result.ok) process.exitCode = 1;
}

async function handleBookmarks(args: string[]): Promise<void> {
  const count = parseCountOption(args);
  const result = await getBookmarksService(count);
  output(result);
  if (!result.ok) process.exitCode = 1;
}

async function handleHome(args: string[]): Promise<void> {
  const count = parseCountOption(args);
  const result = await getHome(count);
  output(result);
  if (!result.ok) process.exitCode = 1;
}

async function handleNotifications(args: string[]): Promise<void> {
  const count = parseCountOption(args);
  const result = await getNotificationsService(count);
  output(result);
  if (!result.ok) process.exitCode = 1;
}

async function handleLikes(args: string[]): Promise<void> {
  const screenName = getPositionalArg(args, 0);
  if (!screenName) {
    outputError("Missing required argument: <screenName>");
    return;
  }
  const count = parseCountOption(args);
  const result = await getLikesService(screenName, count);
  output(result);
  if (!result.ok) process.exitCode = 1;
}

async function handleFollowers(args: string[]): Promise<void> {
  const screenName = getPositionalArg(args, 0);
  if (!screenName) {
    outputError("Missing required argument: <screenName>");
    return;
  }
  const result = await getFollowersService(screenName);
  output(result);
  if (!result.ok) process.exitCode = 1;
}

async function handleFollowing(args: string[]): Promise<void> {
  const screenName = getPositionalArg(args, 0);
  if (!screenName) {
    outputError("Missing required argument: <screenName>");
    return;
  }
  const count = parseCountOption(args);
  const result = await getFollowingService(screenName, count);
  output(result);
  if (!result.ok) process.exitCode = 1;
}

async function handleMedia(args: string[]): Promise<void> {
  const screenName = getPositionalArg(args, 0);
  if (!screenName) {
    outputError("Missing required argument: <screenName>");
    return;
  }
  const count = parseCountOption(args);
  const result = await getMediaService(screenName, count);
  output(result);
  if (!result.ok) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printUsage();
    if (args.length === 0) process.exitCode = 1;
    return;
  }

  const command = args[0];
  const commandArgs = args.slice(1);

  switch (command) {
    case "status":
      await handleStatus();
      break;
    case "login":
      await handleLogin(commandArgs);
      break;
    case "logout":
      handleLogout();
      break;
    case "refresh":
      await handleRefresh(commandArgs);
      break;
    case "strategy":
      await handleStrategy(commandArgs);
      break;
    case "post":
      await handlePost(commandArgs);
      break;
    case "reply":
      await handleReply(commandArgs);
      break;
    case "timeline":
      await handleTimeline(commandArgs);
      break;
    case "tweet":
      await handleTweet(commandArgs);
      break;
    case "search":
      await handleSearch(commandArgs);
      break;
    case "bookmarks":
      await handleBookmarks(commandArgs);
      break;
    case "home":
      await handleHome(commandArgs);
      break;
    case "notifications":
      await handleNotifications(commandArgs);
      break;
    case "likes":
      await handleLikes(commandArgs);
      break;
    case "followers":
      await handleFollowers(commandArgs);
      break;
    case "following":
      await handleFollowing(commandArgs);
      break;
    case "media":
      await handleMedia(commandArgs);
      break;
    default:
      outputError(`Unknown command: ${command}`);
      printUsage();
      break;
  }
}

main();
