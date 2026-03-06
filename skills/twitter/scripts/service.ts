/**
 * Twitter skill service - portable business logic.
 *
 * Wraps the Twitter client modules in the assistant package to provide
 * a clean interface for CLI operations. All functions return structured
 * results suitable for JSON output.
 */

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
  type NotificationEntry,
  type PostTweetResult,
  type TweetEntry,
  type UserInfo,
} from "../../../assistant/src/twitter/client.js";
import { routedPostTweet } from "../../../assistant/src/twitter/router.js";
import {
  clearSession,
  importFromRecording,
  loadSession,
  type TwitterSession,
} from "../../../assistant/src/twitter/session.js";
import {
  ensureChromeWithCdp,
  minimizeChromeWindow,
} from "../../../assistant/src/tools/browser/chrome-cdp.js";
import { getSocketPath, readSessionToken } from "../../../assistant/src/util/platform.js";
import {
  createMessageParser,
  serialize,
  type ClientMessage,
} from "../../../assistant/src/daemon/ipc-protocol.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ServiceResult<T = unknown> {
  ok: true;
  data: T;
}

export interface ServiceError {
  ok: false;
  error: string;
  pathUsed?: string;
  suggestAlternative?: string;
  oauthError?: string;
}

export type ServiceResponse<T = unknown> = ServiceResult<T> | ServiceError;

export const SESSION_EXPIRED_MSG =
  "Your Twitter session has expired. Please sign in to Twitter in Chrome - " +
  "run `bun run scripts/x-cli.ts refresh` to capture your session automatically.";

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

function handleSessionExpiredError(err: SessionExpiredError): ServiceError {
  const meta = err as Record<string, unknown>;
  const result: ServiceError = {
    ok: false,
    error: "session_expired",
  };
  if (meta.pathUsed !== undefined) result.pathUsed = String(meta.pathUsed);
  if (meta.suggestAlternative !== undefined) result.suggestAlternative = String(meta.suggestAlternative);
  if (meta.oauthError !== undefined) result.oauthError = String(meta.oauthError);
  return result;
}

function handleError(err: unknown): ServiceError {
  if (err instanceof SessionExpiredError) {
    return handleSessionExpiredError(err);
  }
  const meta = err as Record<string, unknown>;
  if (
    err instanceof Error &&
    (meta.pathUsed !== undefined ||
      meta.suggestAlternative !== undefined ||
      meta.oauthError !== undefined)
  ) {
    const result: ServiceError = {
      ok: false,
      error: err.message,
    };
    if (meta.pathUsed !== undefined) result.pathUsed = String(meta.pathUsed);
    if (meta.suggestAlternative !== undefined) result.suggestAlternative = String(meta.suggestAlternative);
    if (meta.oauthError !== undefined) result.oauthError = String(meta.oauthError);
    return result;
  }
  return {
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  };
}

// ---------------------------------------------------------------------------
// Daemon IPC helper
// ---------------------------------------------------------------------------

export function sendDaemonMessage(
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
// Session management
// ---------------------------------------------------------------------------

export interface StatusResult {
  loggedIn: boolean;
  browserSessionActive: boolean;
  cookieCount?: number;
  importedAt?: string;
  recordingId?: string;
  oauthConnected?: boolean;
  oauthAccount?: string;
  preferredStrategy?: string;
  strategyConfigured?: boolean;
}

export async function getStatus(): Promise<ServiceResponse<StatusResult>> {
  try {
    const session = loadSession();
    const browserInfo: Partial<StatusResult> = session
      ? {
          browserSessionActive: true,
          cookieCount: session.cookies.length,
          importedAt: session.importedAt,
          recordingId: session.recordingId,
        }
      : { browserSessionActive: false };

    let oauthInfo: Partial<StatusResult> = {};
    try {
      const daemonResponse = await sendDaemonMessage(
        {
          type: "twitter_integration_config",
          action: "get",
        } as ClientMessage,
        "twitter_integration_config_response",
      );
      const r = daemonResponse as Record<string, unknown>;
      oauthInfo = {
        oauthConnected: (r.connected as boolean) ?? false,
        oauthAccount: r.accountInfo as string | undefined,
        preferredStrategy: (r.strategy as string) ?? "auto",
        strategyConfigured: r.strategyConfigured as boolean | undefined,
      };
    } catch {
      oauthInfo = {
        oauthConnected: undefined,
        oauthAccount: undefined,
        preferredStrategy: undefined,
        strategyConfigured: undefined,
      };
    }

    return {
      ok: true,
      data: {
        loggedIn: !!session,
        ...browserInfo,
        ...oauthInfo,
      } as StatusResult,
    };
  } catch (err) {
    return handleError(err);
  }
}

export interface LoginResult {
  message: string;
  cookieCount: number;
  recordingId?: string;
}

export function login(recordingPath: string): ServiceResponse<LoginResult> {
  try {
    const session = importFromRecording(recordingPath);
    return {
      ok: true,
      data: {
        message: "Session imported successfully",
        cookieCount: session.cookies.length,
        recordingId: session.recordingId,
      },
    };
  } catch (err) {
    return handleError(err);
  }
}

export interface LogoutResult {
  message: string;
}

export function logout(): ServiceResponse<LogoutResult> {
  try {
    clearSession();
    return {
      ok: true,
      data: { message: "Session cleared" },
    };
  } catch (err) {
    return handleError(err);
  }
}

// ---------------------------------------------------------------------------
// Refresh (Ride Shotgun) session
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
        } as unknown as ClientMessage),
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
          } as unknown as ClientMessage),
        );
      } else {
        sendStartCommand();
      }
    });
  });
}

export interface RefreshResult {
  message: string;
  cookieCount: number;
  recordingId?: string;
}

export async function refresh(durationSeconds: number = 180): Promise<ServiceResponse<RefreshResult>> {
  try {
    const result = await startLearnSession(durationSeconds);
    if (result.recordingPath) {
      const session = importFromRecording(result.recordingPath);

      try {
        await minimizeChromeWindow();
      } catch {
        /* best-effort */
      }

      return {
        ok: true,
        data: {
          message: "Session refreshed successfully",
          cookieCount: session.cookies.length,
          recordingId: result.recordingId,
        },
      };
    } else {
      return {
        ok: false,
        error: "Recording completed but no recording path returned",
      };
    }
  } catch (err) {
    return handleError(err);
  }
}

// ---------------------------------------------------------------------------
// Strategy management
// ---------------------------------------------------------------------------

export interface StrategyResult {
  strategy: string;
}

export async function getStrategy(): Promise<ServiceResponse<StrategyResult>> {
  try {
    const daemonResponse = await sendDaemonMessage(
      {
        type: "twitter_integration_config",
        action: "get_strategy",
      } as ClientMessage,
      "twitter_integration_config_response",
    );
    const r = daemonResponse as Record<string, unknown>;
    return {
      ok: true,
      data: { strategy: (r.strategy as string) ?? "auto" },
    };
  } catch (err) {
    return handleError(err);
  }
}

export async function setStrategy(value: string): Promise<ServiceResponse<StrategyResult>> {
  try {
    const daemonResponse = await sendDaemonMessage(
      {
        type: "twitter_integration_config",
        action: "set_strategy",
        strategy: value,
      } as ClientMessage,
      "twitter_integration_config_response",
    );
    const r = daemonResponse as Record<string, unknown>;
    if (r.success) {
      return {
        ok: true,
        data: { strategy: r.strategy as string },
      };
    } else {
      return {
        ok: false,
        error: (r.error as string) ?? "Failed to set strategy",
      };
    }
  } catch (err) {
    return handleError(err);
  }
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

export interface PostResult {
  tweetId: string;
  text: string;
  url: string;
  pathUsed: string;
}

export async function post(text: string): Promise<ServiceResponse<PostResult>> {
  try {
    const { result, pathUsed } = await routedPostTweet(text);
    return {
      ok: true,
      data: {
        tweetId: result.tweetId,
        text: result.text,
        url: result.url,
        pathUsed,
      },
    };
  } catch (err) {
    return handleError(err);
  }
}

export interface ReplyResult {
  tweetId: string;
  text: string;
  url: string;
  inReplyToTweetId: string;
  pathUsed: string;
}

export async function reply(tweetUrl: string, text: string): Promise<ServiceResponse<ReplyResult>> {
  try {
    const idMatch = tweetUrl.match(/(\d+)\s*$/);
    if (!idMatch) {
      return {
        ok: false,
        error: `Could not extract tweet ID from: ${tweetUrl}`,
      };
    }
    const inReplyToTweetId = idMatch[1];
    const { result, pathUsed } = await routedPostTweet(text, { inReplyToTweetId });
    return {
      ok: true,
      data: {
        tweetId: result.tweetId,
        text: result.text,
        url: result.url,
        inReplyToTweetId,
        pathUsed,
      },
    };
  } catch (err) {
    return handleError(err);
  }
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

export interface TimelineResult {
  user: UserInfo;
  tweets: TweetEntry[];
}

export async function getTimeline(screenName: string, count: number = 20): Promise<ServiceResponse<TimelineResult>> {
  try {
    const user = await getUserByScreenName(screenName.replace(/^@/, ""));
    const tweets = await getUserTweets(user.userId, count);
    return {
      ok: true,
      data: { user, tweets },
    };
  } catch (err) {
    return handleError(err);
  }
}

export interface TweetDetailResult {
  tweets: TweetEntry[];
}

export async function getTweet(tweetIdOrUrl: string): Promise<ServiceResponse<TweetDetailResult>> {
  try {
    const idMatch = tweetIdOrUrl.match(/(\d+)\s*$/);
    if (!idMatch) {
      return {
        ok: false,
        error: `Could not extract tweet ID from: ${tweetIdOrUrl}`,
      };
    }
    const tweets = await getTweetDetail(idMatch[1]);
    return {
      ok: true,
      data: { tweets },
    };
  } catch (err) {
    return handleError(err);
  }
}

export interface SearchResult {
  query: string;
  tweets: TweetEntry[];
}

export async function search(
  query: string,
  product: "Top" | "Latest" | "People" | "Media" = "Top",
): Promise<ServiceResponse<SearchResult>> {
  try {
    const tweets = await searchTweets(query, product);
    return {
      ok: true,
      data: { query, tweets },
    };
  } catch (err) {
    return handleError(err);
  }
}

export interface BookmarksResult {
  tweets: TweetEntry[];
}

export async function getBookmarksService(count: number = 20): Promise<ServiceResponse<BookmarksResult>> {
  try {
    const tweets = await getBookmarks(count);
    return {
      ok: true,
      data: { tweets },
    };
  } catch (err) {
    return handleError(err);
  }
}

export interface HomeResult {
  tweets: TweetEntry[];
}

export async function getHome(count: number = 20): Promise<ServiceResponse<HomeResult>> {
  try {
    const tweets = await getHomeTimeline(count);
    return {
      ok: true,
      data: { tweets },
    };
  } catch (err) {
    return handleError(err);
  }
}

export interface NotificationsResult {
  notifications: NotificationEntry[];
}

export async function getNotificationsService(count: number = 20): Promise<ServiceResponse<NotificationsResult>> {
  try {
    const notifications = await getNotifications(count);
    return {
      ok: true,
      data: { notifications },
    };
  } catch (err) {
    return handleError(err);
  }
}

export interface LikesResult {
  user: UserInfo;
  tweets: TweetEntry[];
}

export async function getLikesService(screenName: string, count: number = 20): Promise<ServiceResponse<LikesResult>> {
  try {
    const user = await getUserByScreenName(screenName.replace(/^@/, ""));
    const tweets = await getLikes(user.userId, count);
    return {
      ok: true,
      data: { user, tweets },
    };
  } catch (err) {
    return handleError(err);
  }
}

export interface FollowersResult {
  user: UserInfo;
  followers: UserInfo[];
}

export async function getFollowersService(screenName: string): Promise<ServiceResponse<FollowersResult>> {
  try {
    const cleanName = screenName.replace(/^@/, "");
    const user = await getUserByScreenName(cleanName);
    const followers = await getFollowers(user.userId, cleanName);
    return {
      ok: true,
      data: { user, followers },
    };
  } catch (err) {
    return handleError(err);
  }
}

export interface FollowingResult {
  user: UserInfo;
  following: UserInfo[];
}

export async function getFollowingService(screenName: string, count: number = 20): Promise<ServiceResponse<FollowingResult>> {
  try {
    const user = await getUserByScreenName(screenName.replace(/^@/, ""));
    const following = await getFollowing(user.userId, count);
    return {
      ok: true,
      data: { user, following },
    };
  } catch (err) {
    return handleError(err);
  }
}

export interface MediaResult {
  user: UserInfo;
  tweets: TweetEntry[];
}

export async function getMediaService(screenName: string, count: number = 20): Promise<ServiceResponse<MediaResult>> {
  try {
    const user = await getUserByScreenName(screenName.replace(/^@/, ""));
    const tweets = await getUserMedia(user.userId, count);
    return {
      ok: true,
      data: { user, tweets },
    };
  } catch (err) {
    return handleError(err);
  }
}
