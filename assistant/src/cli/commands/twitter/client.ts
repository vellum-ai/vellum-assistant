/**
 * Twitter API client.
 * Executes GraphQL queries through Chrome's CDP (Runtime.evaluate) so requests
 * go through the browser's authenticated session.
 */

import { loadSession, type TwitterSession } from "./session.js";

class ProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

const CDP_BASE = "http://localhost:9222";

/** Static bearer token used by x.com for all GraphQL requests. */
const BEARER_TOKEN =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

// ─── Query IDs (captured from x.com) ─────────────────────────────────────────

const QUERY_IDS = {
  CreateTweet: "Ah3G_byjEDs_HSlgU0PyZw",
  UserByScreenName: "AWbeRIdkLtqTRN7yL_H8yw",
  UserTweets: "N2tFDY-MlrLxXJ9F_ZxJGA",
  TweetDetail: "YCNdW_ZytXfV9YR3cJK9kw",
  SearchTimeline: "ML-n2SfAxx5S_9QMqNejbg",
  Bookmarks: "toTC7lB_mQm5fuBE5yyEJw",
  HomeTimeline: "nn16KxqX3E1OdE7WlHB5LA",
  NotificationsTimeline: "saZw4lppu6QzMEiRUCYurg",
  Likes: "Pcw-j9lrSeDMmkgnIejJiQ",
  Followers: "P7m4Qr-rJEB8KUluOenU6A",
  Following: "T5wihsMTYHncY7BB4YxHSg",
  UserMedia: "xLCC9bG_VqHfXXgq8jPoCg",
} as const;

/** Feature flags shared by all GraphQL endpoints. */
const FEATURES: Record<string, boolean> = {
  rweb_video_screen_enabled: false,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: false,
  rweb_tipjar_consumption_enabled: false,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: true,
  responsive_web_jetfuel_frame: true,
  responsive_web_grok_share_attachment_enabled: true,
  responsive_web_grok_annotations_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  responsive_web_grok_show_grok_translated_post: true,
  responsive_web_grok_analysis_button_from_backend: true,
  post_ctas_fetch_enabled: true,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_grok_image_annotation_enabled: true,
  responsive_web_grok_imagine_annotation_enabled: true,
  responsive_web_grok_community_note_auto_translation_is_enabled: false,
  responsive_web_enhance_cards_enabled: false,
};

// ─── Errors ──────────────────────────────────────────────────────────────────

/** Thrown when the session is missing or expired. */
export class SessionExpiredError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SessionExpiredError";
  }
}

function requireSession(): TwitterSession {
  const session = loadSession();
  if (!session) {
    throw new SessionExpiredError("No Twitter session found.");
  }
  return session;
}

// ─── CDP transport ───────────────────────────────────────────────────────────

async function findTwitterTab(): Promise<string> {
  const res = await fetch(`${CDP_BASE}/json/list`).catch(() => null);
  if (!res?.ok) {
    throw new SessionExpiredError(
      "Chrome CDP not available. Run `assistant twitter refresh` first.",
    );
  }
  const targets = (await res.json()) as Array<{
    type: string;
    url: string;
    webSocketDebuggerUrl: string;
  }>;
  const tab = targets.find(
    (t) =>
      t.type === "page" &&
      (t.url.includes("x.com") || t.url.includes("twitter.com")),
  );
  if (!tab?.webSocketDebuggerUrl) {
    throw new SessionExpiredError(
      "No x.com tab found in Chrome. Open x.com and try again.",
    );
  }
  return tab.webSocketDebuggerUrl;
}

/** Standard headers for X API requests (as a JS expression for Runtime.evaluate). */
const API_HEADERS_GET = `{
      'authorization': 'Bearer ${BEARER_TOKEN}',
      'x-csrf-token': csrf,
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-active-user': 'yes',
      'x-twitter-client-language': 'en',
    }`;

const API_HEADERS_POST = `{
      'Content-Type': 'application/json',
      'authorization': 'Bearer ${BEARER_TOKEN}',
      'x-csrf-token': csrf,
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-active-user': 'yes',
      'x-twitter-client-language': 'en',
    }`;

/** Execute a POST fetch inside Chrome via CDP Runtime.evaluate. */
async function cdpFetch(
  wsUrl: string,
  url: string,
  body: string,
): Promise<unknown> {
  return cdpEval(
    wsUrl,
    `
    (function() {
      var csrf = (document.cookie.match(/ct0=([^;]+)/) || [])[1] || '';
      return fetch(${JSON.stringify(url)}, {
        method: 'POST',
        headers: ${API_HEADERS_POST},
        body: ${JSON.stringify(body)},
        credentials: 'include',
      })
      .then(function(r) {
        if (!r.ok) return r.text().then(function(t) {
          return JSON.stringify({ __status: r.status, __error: true, __body: t.substring(0, 500) });
        });
        return r.text();
      })
      .catch(function(e) { return JSON.stringify({ __error: true, __message: e.message }); });
    })()
  `,
  );
}

/** Execute a GET fetch inside Chrome via CDP Runtime.evaluate. */
async function cdpGet(wsUrl: string, url: string): Promise<unknown> {
  return cdpEval(
    wsUrl,
    `
    (function() {
      var csrf = (document.cookie.match(/ct0=([^;]+)/) || [])[1] || '';
      return fetch(${JSON.stringify(url)}, {
        method: 'GET',
        headers: ${API_HEADERS_GET},
        credentials: 'include',
      })
      .then(function(r) {
        if (!r.ok) return r.text().then(function(t) {
          return JSON.stringify({ __status: r.status, __error: true, __body: t.substring(0, 500) });
        });
        return r.text();
      })
      .catch(function(e) { return JSON.stringify({ __error: true, __message: e.message }); });
    })()
  `,
  );
}

/**
 * Navigate Chrome to a URL and capture the response body of a specific GraphQL query.
 * This works for endpoints that require X's client-generated transaction ID (e.g. Search, Followers)
 * because the browser's own JavaScript generates the correct headers.
 */
async function cdpNavigateAndCapture(
  wsUrl: string,
  pageUrl: string,
  queryName: string,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const callbacks = new Map<number, (v: unknown) => void>();
    const pendingRequestIds = new Set<string>();

    const timeout = setTimeout(() => {
      ws.close();
      reject(
        new Error(`CDP navigate+capture timed out waiting for ${queryName}`),
      );
    }, 30000);

    function send(
      method: string,
      params?: Record<string, unknown>,
    ): Promise<unknown> {
      const id = nextId++;
      return new Promise((r) => {
        callbacks.set(id, r);
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    ws.onmessage = (event) => {
      const msg = JSON.parse(typeof event.data === "string" ? event.data : "");

      // Handle command responses
      if (msg.id != null && callbacks.has(msg.id)) {
        callbacks.get(msg.id)!(msg.result ?? msg.error);
        callbacks.delete(msg.id);
        return;
      }

      // Track GraphQL requests matching our query name
      if (msg.method === "Network.requestWillBeSent") {
        const req = msg.params?.request;
        const url = req?.url as string | undefined;
        if (url?.includes(`/graphql/`) && url?.includes(`/${queryName}`)) {
          pendingRequestIds.add(msg.params.requestId as string);
        }
      }

      // Capture response when loading finishes
      if (msg.method === "Network.loadingFinished") {
        const requestId = msg.params?.requestId as string;
        if (!pendingRequestIds.has(requestId)) return;
        pendingRequestIds.delete(requestId);

        send("Network.getResponseBody", { requestId })
          .then((result) => {
            const body = (result as Record<string, unknown>)?.body as string;
            if (!body) return;
            try {
              const json = JSON.parse(body);
              clearTimeout(timeout);
              ws.close();
              if (json.errors?.length) {
                reject(
                  new Error(
                    `X API errors: ${json.errors.map((e: { message: string }) => e.message).join("; ")}`,
                  ),
                );
              } else {
                resolve(json);
              }
            } catch {
              /* not JSON, skip */
            }
          })
          .catch(() => {
            /* ignore */
          });
      }
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new SessionExpiredError("CDP connection failed."));
    };

    ws.onopen = async () => {
      await send("Network.enable");
      await send("Page.enable");
      await send("Page.navigate", { url: pageUrl });
    };
  });
}

/** Shared CDP evaluate helper. */
async function cdpEval(wsUrl: string, expression: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = 1;

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("CDP fetch timed out after 30s"));
    }, 30000);

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(
          typeof event.data === "string" ? event.data : "",
        );
        if (msg.id === id) {
          clearTimeout(timeout);
          ws.close();

          if (msg.error) {
            reject(new Error(`CDP error: ${msg.error.message}`));
            return;
          }

          const value = msg.result?.result?.value;
          if (!value) {
            reject(new Error("Empty CDP response"));
            return;
          }

          const parsed = typeof value === "string" ? JSON.parse(value) : value;
          if (parsed.__error) {
            if (parsed.__status === 403 || parsed.__status === 401) {
              reject(new SessionExpiredError("Twitter session has expired."));
            } else {
              reject(
                new Error(
                  parsed.__message ??
                    `HTTP ${parsed.__status}: ${parsed.__body ?? ""}`,
                ),
              );
            }
            return;
          }
          resolve(parsed);
        }
      } catch (err) {
        clearTimeout(timeout);
        ws.close();
        reject(err);
      }
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new SessionExpiredError("CDP connection failed."));
    };
  });
}

// ─── GraphQL helpers ─────────────────────────────────────────────────────────

/** Build a GraphQL GET URL with encoded variables and features. */
function graphqlUrl(
  queryId: string,
  queryName: string,
  variables: Record<string, unknown>,
): string {
  const v = encodeURIComponent(JSON.stringify(variables));
  const f = encodeURIComponent(JSON.stringify(FEATURES));
  return `https://x.com/i/api/graphql/${queryId}/${queryName}?variables=${v}&features=${f}`;
}

/** Execute a GraphQL GET query and return the parsed response. */
async function graphqlGet(
  queryId: string,
  queryName: string,
  variables: Record<string, unknown>,
): Promise<unknown> {
  requireSession();
  const wsUrl = await findTwitterTab();
  const url = graphqlUrl(queryId, queryName, variables);
  const json = (await cdpGet(wsUrl, url)) as {
    errors?: Array<{ message: string }>;
  };
  if (json.errors?.length) {
    throw new ProviderError(
      `X API errors: ${json.errors.map((e) => e.message).join("; ")}`,
      "x",
    );
  }
  return json;
}

// ─── Twitter API response types ──────────────────────────────────────────────

interface TwitterUserLegacy {
  screen_name?: string;
  name?: string;
}

interface TwitterUserCore {
  screen_name?: string;
  name?: string;
}

interface TwitterUserResult {
  rest_id?: string;
  legacy?: TwitterUserLegacy;
  core?: TwitterUserCore;
}

interface TwitterUserResults {
  result?: TwitterUserResult;
}

interface TweetLegacy {
  full_text?: string;
  created_at?: string;
}

interface TweetResult {
  __typename?: string;
  rest_id?: string;
  legacy?: TweetLegacy;
  core?: { user_results?: TwitterUserResults };
  tweet?: TweetResult;
}

interface TweetResults {
  result?: TweetResult;
}

interface TimelineItemContent {
  __typename?: string;
  tweet_results?: TweetResults;
  user_results?: TwitterUserResults;
  // Notification-specific fields
  id?: string;
  rich_message?: { text?: string };
  notification_text?: { text?: string };
  timestamp_ms?: string;
  notification_url?: { url?: string };
}

interface TimelineModuleItem {
  item?: { itemContent?: TimelineItemContent };
}

interface TimelineEntryContent {
  itemContent?: TimelineItemContent;
  items?: TimelineModuleItem[];
}

interface TimelineEntry {
  entryId?: string;
  content?: TimelineEntryContent;
}

interface TimelineInstruction {
  entries?: TimelineEntry[];
}

interface TimelineContainer {
  instructions?: TimelineInstruction[];
}

interface TimelineWrapper {
  timeline?: TimelineContainer;
}

interface TwitterApiError {
  message: string;
}

/** Response from CreateTweet mutation. */
interface CreateTweetResponse {
  errors?: TwitterApiError[];
  data?: {
    create_tweet?: {
      tweet_results?: TweetResults;
    };
  };
}

/** Response from UserByScreenName query. */
interface UserByScreenNameResponse {
  data?: {
    user?: {
      result?: TwitterUserResult;
    };
  };
}

/** Response from UserTweets query. */
interface UserTweetsResponse {
  data?: {
    user?: {
      result?: {
        timeline_v2?: TimelineWrapper;
        timeline?: TimelineWrapper;
      };
    };
  };
}

/** Response from TweetDetail query. */
interface TweetDetailResponse {
  data?: {
    threaded_conversation_with_injections_v2?: TimelineContainer;
  };
}

/** Response from SearchTimeline query. */
interface SearchTimelineResponse {
  data?: {
    search_by_raw_query?: {
      search_timeline?: TimelineWrapper;
    };
  };
}

/** Response from Bookmarks query. */
interface BookmarksResponse {
  data?: {
    bookmark_timeline_v2?: TimelineWrapper;
  };
}

/** Response from HomeTimeline query. */
interface HomeTimelineResponse {
  data?: {
    home?: {
      home_timeline_urt?: TimelineContainer;
    };
  };
}

/** Response from NotificationsTimeline query. */
interface NotificationsTimelineResponse {
  data?: {
    viewer_v2?: {
      user_results?: {
        result?: {
          notification_timeline?: TimelineWrapper;
        };
      };
    };
  };
}

/** Response from Likes / Following / Followers / UserMedia queries. */
interface UserTimelineResponse {
  data?: {
    user?: {
      result?: {
        timeline?: TimelineWrapper;
      };
    };
  };
}

// ─── Tweet extraction helpers ────────────────────────────────────────────────

function extractScreenName(tweetResult: TweetResult): string {
  return (
    tweetResult?.core?.user_results?.result?.legacy?.screen_name ??
    tweetResult?.core?.user_results?.result?.core?.screen_name ??
    "i"
  );
}

/** Extract tweets from a timeline instructions array (shared by most endpoints). */
function extractTweetsFromInstructions(
  instructions: TimelineInstruction[],
): TweetEntry[] {
  const tweets: TweetEntry[] = [];
  for (const instruction of instructions) {
    // Handle both array-style entries and direct entries
    const entries = instruction.entries ?? [];
    for (const entry of entries) {
      // Standard tweet entry
      let tweetResult = entry.content?.itemContent?.tweet_results?.result;
      // Some results wrap in __typename: "TweetWithVisibilityResults"
      if (tweetResult?.__typename === "TweetWithVisibilityResults") {
        tweetResult = tweetResult.tweet;
      }
      if (tweetResult?.rest_id) {
        tweets.push({
          tweetId: tweetResult.rest_id,
          text: tweetResult.legacy?.full_text ?? "",
          url: `https://x.com/${extractScreenName(tweetResult)}/status/${tweetResult.rest_id}`,
          createdAt: tweetResult.legacy?.created_at ?? "",
        });
      }

      // Search results can have TimelineTimelineModule with nested items
      if (entry.content?.items) {
        for (const item of entry.content.items) {
          let tr = item.item?.itemContent?.tweet_results?.result;
          if (tr?.__typename === "TweetWithVisibilityResults") tr = tr.tweet;
          if (tr?.rest_id) {
            tweets.push({
              tweetId: tr.rest_id,
              text: tr.legacy?.full_text ?? "",
              url: `https://x.com/${extractScreenName(tr)}/status/${tr.rest_id}`,
              createdAt: tr.legacy?.created_at ?? "",
            });
          }
        }
      }
    }
  }
  return tweets;
}

/** Extract users from a timeline instructions array (Followers/Following). */
function extractUsersFromInstructions(
  instructions: TimelineInstruction[],
): UserInfo[] {
  const users: UserInfo[] = [];
  for (const instruction of instructions) {
    for (const entry of instruction.entries ?? []) {
      const userResult = entry.content?.itemContent?.user_results?.result;
      if (userResult?.rest_id) {
        users.push({
          userId: userResult.rest_id,
          screenName:
            userResult.legacy?.screen_name ??
            userResult.core?.screen_name ??
            "",
          name: userResult.legacy?.name ?? userResult.core?.name ?? "",
        });
      }
    }
  }
  return users;
}

// ─── Public types ────────────────────────────────────────────────────────────

export interface PostTweetResult {
  tweetId: string;
  text: string;
  url: string;
}

export interface UserInfo {
  userId: string;
  screenName: string;
  name: string;
}

export interface TweetEntry {
  tweetId: string;
  text: string;
  url: string;
  createdAt: string;
}

export interface NotificationEntry {
  id: string;
  message: string;
  timestamp: string;
  url?: string;
}

// ─── Write operations ────────────────────────────────────────────────────────

export async function postTweet(
  text: string,
  opts?: { inReplyToTweetId?: string },
): Promise<PostTweetResult> {
  requireSession();

  const wsUrl = await findTwitterTab();
  const url = `https://x.com/i/api/graphql/${QUERY_IDS.CreateTweet}/CreateTweet`;
  const variables: Record<string, unknown> = {
    tweet_text: text,
    dark_request: false,
    media: {
      media_entities: [],
      possibly_sensitive: false,
    },
    semantic_annotation_ids: [],
    disallowed_reply_options: null,
  };
  if (opts?.inReplyToTweetId) {
    variables.reply = {
      in_reply_to_tweet_id: opts.inReplyToTweetId,
      exclude_reply_user_ids: [],
    };
  }
  const body = JSON.stringify({
    variables,
    features: FEATURES,
    queryId: QUERY_IDS.CreateTweet,
  });

  const json = (await cdpFetch(wsUrl, url, body)) as CreateTweetResponse;

  if (json.errors?.length) {
    throw new ProviderError(
      `X API errors: ${json.errors.map((e) => e.message).join("; ")}`,
      "x",
    );
  }

  const tweetResults = json.data?.create_tweet?.tweet_results;
  const result = tweetResults?.result;
  if (!result?.rest_id) {
    if (tweetResults && !result) {
      throw new ProviderError(
        "X rejected this post — it may be a duplicate of a recent post. Try different text.",
        "x",
      );
    }
    throw new ProviderError(
      `Unexpected response from X API. Response: ${JSON.stringify(json).slice(0, 500)}`,
      "x",
    );
  }

  return {
    tweetId: result.rest_id,
    text,
    url: `https://x.com/${extractScreenName(result)}/status/${result.rest_id}`,
  };
}

// ─── User lookup ─────────────────────────────────────────────────────────────

export async function getUserByScreenName(
  screenName: string,
): Promise<UserInfo> {
  const json = (await graphqlGet(
    QUERY_IDS.UserByScreenName,
    "UserByScreenName",
    {
      screen_name: screenName,
      withGrokTranslatedBio: true,
    },
  )) as UserByScreenNameResponse;

  const user = json.data?.user?.result;
  if (!user?.rest_id) {
    throw new ProviderError(`User @${screenName} not found`, "x");
  }

  return {
    userId: user.rest_id,
    screenName: user.legacy?.screen_name ?? screenName,
    name: user.legacy?.name ?? screenName,
  };
}

// ─── User tweets ─────────────────────────────────────────────────────────────

export async function getUserTweets(
  userId: string,
  count = 20,
): Promise<TweetEntry[]> {
  const json = (await graphqlGet(QUERY_IDS.UserTweets, "UserTweets", {
    userId,
    count,
    includePromotedContent: true,
    withQuickPromoteEligibilityTweetFields: true,
    withVoice: true,
  })) as UserTweetsResponse;

  // Response path: data.user.result.timeline_v2.timeline.instructions[]
  // Fallback to data.user.result.timeline.timeline.instructions[]
  const timelineData =
    json.data?.user?.result?.timeline_v2 ?? json.data?.user?.result?.timeline;
  const instructions = timelineData?.timeline?.instructions ?? [];
  return extractTweetsFromInstructions(instructions);
}

// ─── Tweet detail ────────────────────────────────────────────────────────────

export async function getTweetDetail(tweetId: string): Promise<TweetEntry[]> {
  const json = (await graphqlGet(QUERY_IDS.TweetDetail, "TweetDetail", {
    focalTweetId: tweetId,
    referrer: "tweet",
    with_rux_injections: false,
    rankingMode: "Relevance",
    includePromotedContent: true,
    withCommunity: true,
    withQuickPromoteEligibilityTweetFields: true,
    withBirdwatchNotes: true,
    withVoice: true,
  })) as TweetDetailResponse;

  // Response path: data.threaded_conversation_with_injections_v2.instructions[]
  const instructions =
    json.data?.threaded_conversation_with_injections_v2?.instructions ?? [];
  return extractTweetsFromInstructions(instructions);
}

// ─── Search ──────────────────────────────────────────────────────────────────

export async function searchTweets(
  query: string,
  product: "Top" | "Latest" | "People" | "Media" = "Top",
): Promise<TweetEntry[]> {
  requireSession();
  const wsUrl = await findTwitterTab();

  // Search requires X's client-generated transaction ID, so we navigate Chrome
  // to the search page and capture the response from network events.
  const productParam = product === "Top" ? "" : `&f=${product.toLowerCase()}`;
  const pageUrl = `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query${productParam}`;
  const json = (await cdpNavigateAndCapture(
    wsUrl,
    pageUrl,
    "SearchTimeline",
  )) as SearchTimelineResponse;

  const instructions =
    json.data?.search_by_raw_query?.search_timeline?.timeline?.instructions ??
    [];
  return extractTweetsFromInstructions(instructions);
}

// ─── Bookmarks ───────────────────────────────────────────────────────────────

export async function getBookmarks(count = 20): Promise<TweetEntry[]> {
  const json = (await graphqlGet(QUERY_IDS.Bookmarks, "Bookmarks", {
    count,
    includePromotedContent: true,
  })) as BookmarksResponse;

  // Response path: data.bookmark_timeline_v2.timeline.instructions[]
  const instructions =
    json.data?.bookmark_timeline_v2?.timeline?.instructions ?? [];
  return extractTweetsFromInstructions(instructions);
}

// ─── Home timeline ───────────────────────────────────────────────────────────

export async function getHomeTimeline(count = 20): Promise<TweetEntry[]> {
  const json = (await graphqlGet(QUERY_IDS.HomeTimeline, "HomeTimeline", {
    count,
    includePromotedContent: true,
    requestContext: "launch",
    withCommunity: true,
  })) as HomeTimelineResponse;

  // Response path: data.home.home_timeline_urt.instructions[]
  const instructions = json.data?.home?.home_timeline_urt?.instructions ?? [];
  return extractTweetsFromInstructions(instructions);
}

// ─── Notifications ───────────────────────────────────────────────────────────

export async function getNotifications(
  count = 20,
): Promise<NotificationEntry[]> {
  const json = (await graphqlGet(
    QUERY_IDS.NotificationsTimeline,
    "NotificationsTimeline",
    {
      timeline_type: "All",
      count,
    },
  )) as NotificationsTimelineResponse;

  // Response path: data.viewer_v2.user_results.result.notification_timeline.timeline.instructions[]
  const instructions =
    json.data?.viewer_v2?.user_results?.result?.notification_timeline?.timeline
      ?.instructions ?? [];

  const notifications: NotificationEntry[] = [];
  for (const instruction of instructions) {
    for (const entry of instruction.entries ?? []) {
      const ic = entry.content?.itemContent;
      if (ic?.__typename !== "TimelineNotification") continue;
      notifications.push({
        id: ic.id ?? entry.entryId ?? "",
        message: ic.rich_message?.text ?? ic.notification_text?.text ?? "",
        timestamp: ic.timestamp_ms ?? "",
        url: ic.notification_url?.url,
      });
    }
  }
  return notifications;
}

// ─── Likes ───────────────────────────────────────────────────────────────────

export async function getLikes(
  userId: string,
  count = 20,
): Promise<TweetEntry[]> {
  const json = (await graphqlGet(QUERY_IDS.Likes, "Likes", {
    userId,
    count,
    includePromotedContent: false,
    withClientEventToken: false,
    withBirdwatchNotes: false,
    withVoice: true,
  })) as UserTimelineResponse;

  // Response path: data.user.result.timeline.timeline.instructions[]
  const instructions =
    json.data?.user?.result?.timeline?.timeline?.instructions ?? [];
  return extractTweetsFromInstructions(instructions);
}

// ─── Followers ───────────────────────────────────────────────────────────────

export async function getFollowers(
  userId: string,
  screenName?: string,
): Promise<UserInfo[]> {
  // Followers requires X's client-generated transaction ID.
  // Navigate to the followers page and capture via CDP.
  if (screenName) {
    requireSession();
    const wsUrl = await findTwitterTab();
    const json = (await cdpNavigateAndCapture(
      wsUrl,
      `https://x.com/${screenName}/followers`,
      "Followers",
    )) as UserTimelineResponse;
    const instructions =
      json.data?.user?.result?.timeline?.timeline?.instructions ?? [];
    return extractUsersFromInstructions(instructions);
  }

  const json = (await graphqlGet(QUERY_IDS.Followers, "Followers", {
    userId,
    count: 20,
    includePromotedContent: false,
    withGrokTranslatedBio: false,
  })) as UserTimelineResponse;

  const instructions =
    json.data?.user?.result?.timeline?.timeline?.instructions ?? [];
  return extractUsersFromInstructions(instructions);
}

// ─── Following ───────────────────────────────────────────────────────────────

export async function getFollowing(
  userId: string,
  count = 20,
): Promise<UserInfo[]> {
  const json = (await graphqlGet(QUERY_IDS.Following, "Following", {
    userId,
    count,
    includePromotedContent: false,
    withGrokTranslatedBio: false,
  })) as UserTimelineResponse;

  // Response path: data.user.result.timeline.timeline.instructions[]
  const instructions =
    json.data?.user?.result?.timeline?.timeline?.instructions ?? [];
  return extractUsersFromInstructions(instructions);
}

// ─── User media ──────────────────────────────────────────────────────────────

export async function getUserMedia(
  userId: string,
  count = 20,
): Promise<TweetEntry[]> {
  const json = (await graphqlGet(QUERY_IDS.UserMedia, "UserMedia", {
    userId,
    count,
    includePromotedContent: false,
    withClientEventToken: false,
    withBirdwatchNotes: false,
    withVoice: true,
  })) as UserTimelineResponse;

  // Response path: data.user.result.timeline.timeline.instructions[]
  // (same as Likes — contains tweets that have media)
  const instructions =
    json.data?.user?.result?.timeline?.timeline?.instructions ?? [];
  return extractTweetsFromInstructions(instructions);
}
