// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolExecutionResult {
  content: string;
  isError: boolean;
}

export interface TwitterUser {
  id: string;
  screenName: string;
  name: string;
  description?: string;
  profileImageUrl?: string;
  followersCount?: number;
  followingCount?: number;
}

export interface Tweet {
  id: string;
  text: string;
  authorId: string;
  authorScreenName?: string;
  authorName?: string;
  createdAt?: string;
  url?: string;
  replyCount?: number;
  retweetCount?: number;
  likeCount?: number;
  media?: TweetMedia[];
}

export interface TweetMedia {
  type: "photo" | "video" | "animated_gif";
  url: string;
  previewUrl?: string;
}

export interface Notification {
  id: string;
  message: string;
  timestamp?: string;
  url?: string;
}

export interface TwitterStatus {
  oauthConnected: boolean;
  browserSessionActive: boolean;
  preferredStrategy: "oauth" | "browser" | "auto";
  strategyConfigured: boolean;
  screenName?: string;
}

// ---------------------------------------------------------------------------
// Command Types
// ---------------------------------------------------------------------------

export type TwitterCommand =
  | "status"
  | "post"
  | "reply"
  | "timeline"
  | "tweet"
  | "search"
  | "bookmarks"
  | "home"
  | "notifications"
  | "likes"
  | "followers"
  | "following"
  | "media"
  | "login"
  | "logout"
  | "refresh"
  | "strategy";

export interface StatusInput {
  json?: boolean;
}

export interface PostInput {
  text: string;
}

export interface ReplyInput {
  tweetUrl: string;
  text: string;
}

export interface TimelineInput {
  screenName: string;
  count?: number;
}

export interface TweetInput {
  tweetIdOrUrl: string;
}

export interface SearchInput {
  query: string;
  product?: "Top" | "Latest" | "People" | "Media";
}

export interface BookmarksInput {
  count?: number;
}

export interface HomeInput {
  count?: number;
}

export interface NotificationsInput {
  count?: number;
}

export interface LikesInput {
  screenName: string;
  count?: number;
}

export interface FollowersInput {
  screenName: string;
}

export interface FollowingInput {
  screenName: string;
  count?: number;
}

export interface MediaInput {
  screenName: string;
  count?: number;
}

export interface StrategyInput {
  action?: "get" | "set";
  value?: "oauth" | "browser" | "auto";
}

// ---------------------------------------------------------------------------
// Result Types
// ---------------------------------------------------------------------------

export interface PostResult {
  ok: boolean;
  tweetId?: string;
  text?: string;
  url?: string;
  pathUsed?: "oauth" | "browser";
  error?: string;
}

export interface TimelineResult {
  ok: boolean;
  user?: TwitterUser;
  tweets?: Tweet[];
  error?: string;
}

export interface TweetResult {
  ok: boolean;
  tweet?: Tweet;
  replies?: Tweet[];
  error?: string;
}

export interface SearchResult {
  ok: boolean;
  tweets?: Tweet[];
  error?: string;
}

export interface NotificationsResult {
  ok: boolean;
  notifications?: Notification[];
  error?: string;
}

export interface FollowersResult {
  ok: boolean;
  user?: TwitterUser;
  followers?: TwitterUser[];
  error?: string;
}

export interface FollowingResult {
  ok: boolean;
  user?: TwitterUser;
  following?: TwitterUser[];
  error?: string;
}

export interface StrategyResult {
  ok: boolean;
  strategy?: "oauth" | "browser" | "auto";
  error?: string;
}

// ---------------------------------------------------------------------------
// Imports from assistant Twitter modules
// ---------------------------------------------------------------------------

import * as net from "node:net";

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
} from "../../../assistant/src/twitter/client.js";
import { routedPostTweet } from "../../../assistant/src/twitter/router.js";
import {
  clearSession,
  importFromRecording,
  loadSession,
} from "../../../assistant/src/twitter/session.js";
import { oauthIsAvailable } from "../../../assistant/src/twitter/oauth-client.js";
import { loadRawConfig } from "../../../assistant/src/config/loader.js";
import {
  getSocketPath,
  readSessionToken,
} from "../../../assistant/src/util/platform.js";
import {
  createMessageParser,
  serialize,
} from "../../../assistant/src/daemon/ipc-protocol.js";
import type { ClientMessage } from "../../../assistant/src/daemon/ipc-contract.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_EXPIRED_MSG =
  "Your Twitter session has expired. Please import a fresh session recording " +
  "via `login --recording <path>` or switch to OAuth for post/reply operations.";

function success(data: Record<string, unknown>): ToolExecutionResult {
  return {
    content: JSON.stringify({ ok: true, ...data }),
    isError: false,
  };
}

function failure(error: string): ToolExecutionResult {
  return {
    content: JSON.stringify({ ok: false, error }),
    isError: true,
  };
}

function extractTweetId(tweetIdOrUrl: string): string | null {
  // First try to match a Twitter/X status URL pattern
  const urlMatch = tweetIdOrUrl.match(/\/status\/(\d+)/);
  if (urlMatch) {
    return urlMatch[1];
  }
  // Otherwise, treat as a raw tweet ID (pure digits only)
  const idMatch = tweetIdOrUrl.match(/^(\d+)$/);
  return idMatch ? idMatch[1] : null;
}

function getPreferredStrategy(): "oauth" | "browser" | "auto" {
  try {
    const raw = loadRawConfig();
    const strategy = raw.twitterOperationStrategy as string | undefined;
    if (strategy === "oauth" || strategy === "browser") return strategy;
  } catch {
    /* fall through */
  }
  return "auto";
}

// ---------------------------------------------------------------------------
// Daemon IPC helper
// ---------------------------------------------------------------------------

function sendDaemonMessage(
  message: ClientMessage,
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

        if (m.type === expectedResponseType) {
          clearTimeout(timeoutHandle);
          socket.destroy();
          resolve(m);
          return;
        }
      }
    });

    socket.on("connect", () => {
      if (sessionToken) {
        socket.write(
          serialize({
            type: "auth",
            token: sessionToken,
          } as unknown as ClientMessage),
        );
      } else {
        sendPayload();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Command Implementations
// ---------------------------------------------------------------------------

async function handleStatus(input: StatusInput): Promise<ToolExecutionResult> {
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
      } as ClientMessage,
      "twitter_integration_config_response",
    );
    oauthInfo = {
      oauthConnected: daemonResponse.connected ?? false,
      oauthAccount: daemonResponse.accountInfo ?? undefined,
      preferredStrategy: daemonResponse.strategy ?? "auto",
      strategyConfigured: daemonResponse.strategyConfigured ?? false,
    };
  } catch {
    // Daemon may not be running; check OAuth locally and report what we can
    oauthInfo = {
      oauthConnected: oauthIsAvailable(),
      oauthAccount: undefined,
      preferredStrategy: getPreferredStrategy(),
      strategyConfigured: undefined,
    };
  }

  return success({
    loggedIn: !!session,
    ...browserInfo,
    ...oauthInfo,
  });
}

async function handlePost(input: PostInput): Promise<ToolExecutionResult> {
  try {
    const { result, pathUsed } = await routedPostTweet(input.text);
    return success({
      tweetId: result.tweetId,
      text: result.text,
      url: result.url,
      pathUsed,
    });
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      return failure(SESSION_EXPIRED_MSG);
    }
    const meta = err as Record<string, unknown>;
    if (meta.pathUsed !== undefined) {
      return {
        content: JSON.stringify({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          pathUsed: meta.pathUsed,
          suggestAlternative: meta.suggestAlternative,
          oauthError: meta.oauthError,
        }),
        isError: true,
      };
    }
    return failure(err instanceof Error ? err.message : String(err));
  }
}

async function handleReply(input: ReplyInput): Promise<ToolExecutionResult> {
  const tweetId = extractTweetId(input.tweetUrl);
  if (!tweetId) {
    return failure(`Could not extract tweet ID from: ${input.tweetUrl}`);
  }

  try {
    const { result, pathUsed } = await routedPostTweet(input.text, {
      inReplyToTweetId: tweetId,
    });
    return success({
      tweetId: result.tweetId,
      text: result.text,
      url: result.url,
      inReplyToTweetId: tweetId,
      pathUsed,
    });
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      return failure(SESSION_EXPIRED_MSG);
    }
    const meta = err as Record<string, unknown>;
    if (meta.pathUsed !== undefined) {
      return {
        content: JSON.stringify({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          pathUsed: meta.pathUsed,
          suggestAlternative: meta.suggestAlternative,
          oauthError: meta.oauthError,
        }),
        isError: true,
      };
    }
    return failure(err instanceof Error ? err.message : String(err));
  }
}

async function handleTimeline(
  input: TimelineInput,
): Promise<ToolExecutionResult> {
  try {
    const screenName = input.screenName.replace(/^@/, "");
    const user = await getUserByScreenName(screenName);
    const tweets = await getUserTweets(user.userId, input.count ?? 20);
    return success({
      user: {
        id: user.userId,
        screenName: user.screenName,
        name: user.name,
      },
      tweets: tweets.map((t) => ({
        id: t.tweetId,
        text: t.text,
        url: t.url,
        createdAt: t.createdAt,
      })),
    });
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      return failure(SESSION_EXPIRED_MSG);
    }
    return failure(err instanceof Error ? err.message : String(err));
  }
}

async function handleTweet(input: TweetInput): Promise<ToolExecutionResult> {
  const tweetId = extractTweetId(input.tweetIdOrUrl);
  if (!tweetId) {
    return failure(`Could not extract tweet ID from: ${input.tweetIdOrUrl}`);
  }

  try {
    const tweets = await getTweetDetail(tweetId);
    return success({
      tweets: tweets.map((t) => ({
        id: t.tweetId,
        text: t.text,
        url: t.url,
        createdAt: t.createdAt,
      })),
    });
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      return failure(SESSION_EXPIRED_MSG);
    }
    return failure(err instanceof Error ? err.message : String(err));
  }
}

async function handleSearch(input: SearchInput): Promise<ToolExecutionResult> {
  try {
    const tweets = await searchTweets(input.query, input.product ?? "Top");
    return success({
      query: input.query,
      tweets: tweets.map((t) => ({
        id: t.tweetId,
        text: t.text,
        url: t.url,
        createdAt: t.createdAt,
      })),
    });
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      return failure(SESSION_EXPIRED_MSG);
    }
    return failure(err instanceof Error ? err.message : String(err));
  }
}

async function handleBookmarks(
  input: BookmarksInput,
): Promise<ToolExecutionResult> {
  try {
    const tweets = await getBookmarks(input.count ?? 20);
    return success({
      tweets: tweets.map((t) => ({
        id: t.tweetId,
        text: t.text,
        url: t.url,
        createdAt: t.createdAt,
      })),
    });
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      return failure(SESSION_EXPIRED_MSG);
    }
    return failure(err instanceof Error ? err.message : String(err));
  }
}

async function handleHome(input: HomeInput): Promise<ToolExecutionResult> {
  try {
    const tweets = await getHomeTimeline(input.count ?? 20);
    return success({
      tweets: tweets.map((t) => ({
        id: t.tweetId,
        text: t.text,
        url: t.url,
        createdAt: t.createdAt,
      })),
    });
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      return failure(SESSION_EXPIRED_MSG);
    }
    return failure(err instanceof Error ? err.message : String(err));
  }
}

async function handleNotifications(
  input: NotificationsInput,
): Promise<ToolExecutionResult> {
  try {
    const notifications = await getNotifications(input.count ?? 20);
    return success({
      notifications: notifications.map((n) => ({
        id: n.id,
        message: n.message,
        timestamp: n.timestamp,
        url: n.url,
      })),
    });
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      return failure(SESSION_EXPIRED_MSG);
    }
    return failure(err instanceof Error ? err.message : String(err));
  }
}

async function handleLikes(input: LikesInput): Promise<ToolExecutionResult> {
  try {
    const screenName = input.screenName.replace(/^@/, "");
    const user = await getUserByScreenName(screenName);
    const tweets = await getLikes(user.userId, input.count ?? 20);
    return success({
      user: {
        id: user.userId,
        screenName: user.screenName,
        name: user.name,
      },
      tweets: tweets.map((t) => ({
        id: t.tweetId,
        text: t.text,
        url: t.url,
        createdAt: t.createdAt,
      })),
    });
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      return failure(SESSION_EXPIRED_MSG);
    }
    return failure(err instanceof Error ? err.message : String(err));
  }
}

async function handleFollowers(
  input: FollowersInput,
): Promise<ToolExecutionResult> {
  try {
    const screenName = input.screenName.replace(/^@/, "");
    const user = await getUserByScreenName(screenName);
    const followers = await getFollowers(user.userId, screenName);
    return success({
      user: {
        id: user.userId,
        screenName: user.screenName,
        name: user.name,
      },
      followers: followers.map((f) => ({
        id: f.userId,
        screenName: f.screenName,
        name: f.name,
      })),
    });
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      return failure(SESSION_EXPIRED_MSG);
    }
    return failure(err instanceof Error ? err.message : String(err));
  }
}

async function handleFollowing(
  input: FollowingInput,
): Promise<ToolExecutionResult> {
  try {
    const screenName = input.screenName.replace(/^@/, "");
    const user = await getUserByScreenName(screenName);
    const following = await getFollowing(user.userId, input.count ?? 20);
    return success({
      user: {
        id: user.userId,
        screenName: user.screenName,
        name: user.name,
      },
      following: following.map((f) => ({
        id: f.userId,
        screenName: f.screenName,
        name: f.name,
      })),
    });
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      return failure(SESSION_EXPIRED_MSG);
    }
    return failure(err instanceof Error ? err.message : String(err));
  }
}

async function handleMedia(input: MediaInput): Promise<ToolExecutionResult> {
  try {
    const screenName = input.screenName.replace(/^@/, "");
    const user = await getUserByScreenName(screenName);
    const tweets = await getUserMedia(user.userId, input.count ?? 20);
    return success({
      user: {
        id: user.userId,
        screenName: user.screenName,
        name: user.name,
      },
      tweets: tweets.map((t) => ({
        id: t.tweetId,
        text: t.text,
        url: t.url,
        createdAt: t.createdAt,
      })),
    });
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      return failure(SESSION_EXPIRED_MSG);
    }
    return failure(err instanceof Error ? err.message : String(err));
  }
}

async function handleLogin(
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  const recordingPath = input.recording as string | undefined;
  if (!recordingPath) {
    return failure("login requires --recording <path> argument");
  }

  try {
    const session = importFromRecording(recordingPath);
    return success({
      message: "Session imported successfully",
      cookieCount: session.cookies.length,
      recordingId: session.recordingId,
    });
  } catch (err) {
    return failure(err instanceof Error ? err.message : String(err));
  }
}

async function handleLogout(): Promise<ToolExecutionResult> {
  clearSession();
  return success({ message: "Session cleared" });
}

async function handleRefresh(): Promise<ToolExecutionResult> {
  // Refresh requires Chrome CDP and Ride Shotgun. Return guidance for alternatives.
  return failure(
    "Browser session refresh requires Chrome CDP integration. " +
      "Use `login --recording <path>` to import a Ride Shotgun recording, " +
      "or switch to OAuth for post/reply operations.",
  );
}

async function handleStrategy(
  input: StrategyInput,
): Promise<ToolExecutionResult> {
  const action = input.action ?? "get";

  if (action === "get") {
    try {
      const daemonResponse = await sendDaemonMessage(
        {
          type: "twitter_integration_config",
          action: "get_strategy",
        } as ClientMessage,
        "twitter_integration_config_response",
      );
      return success({ strategy: daemonResponse.strategy ?? "auto" });
    } catch {
      // Daemon not running, read from config directly
      return success({ strategy: getPreferredStrategy() });
    }
  }

  if (action === "set") {
    const value = input.value;
    if (!value || !["oauth", "browser", "auto"].includes(value)) {
      return failure(
        'Invalid strategy value. Use "oauth", "browser", or "auto".',
      );
    }

    try {
      const daemonResponse = await sendDaemonMessage(
        {
          type: "twitter_integration_config",
          action: "set_strategy",
          strategy: value,
        } as ClientMessage,
        "twitter_integration_config_response",
      );
      if (daemonResponse.success) {
        return success({ strategy: daemonResponse.strategy });
      } else {
        return failure(
          (daemonResponse.error as string) ?? "Failed to set strategy",
        );
      }
    } catch (err) {
      return failure(
        `Failed to set strategy: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return failure('Invalid strategy action. Use "get" or "set".');
}

// ---------------------------------------------------------------------------
// Main Entry Point
// ---------------------------------------------------------------------------

export async function executeTwitterCommand(
  command: TwitterCommand,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  switch (command) {
    case "status":
      return handleStatus(input as StatusInput);

    case "post":
      return handlePost(input as PostInput);

    case "reply":
      return handleReply(input as ReplyInput);

    case "timeline":
      return handleTimeline(input as TimelineInput);

    case "tweet":
      return handleTweet(input as TweetInput);

    case "search":
      return handleSearch(input as SearchInput);

    case "bookmarks":
      return handleBookmarks(input as BookmarksInput);

    case "home":
      return handleHome(input as HomeInput);

    case "notifications":
      return handleNotifications(input as NotificationsInput);

    case "likes":
      return handleLikes(input as LikesInput);

    case "followers":
      return handleFollowers(input as FollowersInput);

    case "following":
      return handleFollowing(input as FollowingInput);

    case "media":
      return handleMedia(input as MediaInput);

    case "login":
      return handleLogin(input);

    case "logout":
      return handleLogout();

    case "refresh":
      return handleRefresh();

    case "strategy":
      return handleStrategy(input as StrategyInput);

    default:
      return failure(`Unknown command: ${command}`);
  }
}
