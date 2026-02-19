/**
 * Twitter API client.
 * Executes GraphQL mutations through Chrome's CDP (Runtime.evaluate) so requests
 * go through the browser's authenticated session.
 */

import {
  loadSession,
  type TwitterSession,
} from './session.js';

const CDP_BASE = 'http://localhost:9222';

/** Static bearer token used by x.com for all GraphQL requests. */
const BEARER_TOKEN =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

/** Query ID for CreateTweet persisted query. */
const CREATE_TWEET_QUERY_ID = 'Ah3G_byjEDs_HSlgU0PyZw';

/** Feature flags required by the CreateTweet mutation. */
const CREATE_TWEET_FEATURES: Record<string, boolean> = {
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: true,
  responsive_web_jetfuel_frame: true,
  responsive_web_grok_share_attachment_enabled: true,
  responsive_web_grok_annotations_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  responsive_web_grok_show_grok_translated_post: true,
  responsive_web_grok_analysis_button_from_backend: true,
  post_ctas_fetch_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: false,
  rweb_tipjar_consumption_enabled: false,
  verified_phone_label_enabled: false,
  articles_preview_enabled: true,
  responsive_web_grok_community_note_auto_translation_is_enabled: false,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  responsive_web_grok_image_annotation_enabled: true,
  responsive_web_grok_imagine_annotation_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_enhance_cards_enabled: false,
};

/** Thrown when the session is missing or expired. */
export class SessionExpiredError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SessionExpiredError';
  }
}

function requireSession(): TwitterSession {
  const session = loadSession();
  if (!session) {
    throw new SessionExpiredError('No Twitter session found.');
  }
  return session;
}

/**
 * Find a Chrome tab on x.com and return its WebSocket debugger URL.
 */
async function findTwitterTab(): Promise<string> {
  const res = await fetch(`${CDP_BASE}/json/list`).catch(() => null);
  if (!res?.ok) {
    throw new SessionExpiredError('Chrome CDP not available. Run `vellum twitter refresh` first.');
  }
  const targets = (await res.json()) as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
  const twitterTab = targets.find(
    t => t.type === 'page' && (t.url.includes('x.com') || t.url.includes('twitter.com')),
  );
  const tab = twitterTab ?? targets.find(t => t.type === 'page');
  if (!tab?.webSocketDebuggerUrl) {
    throw new SessionExpiredError('No Chrome tab available for Twitter requests.');
  }
  return tab.webSocketDebuggerUrl;
}

/**
 * Execute a fetch() call inside Chrome's page context via CDP Runtime.evaluate.
 */
async function cdpFetch(wsUrl: string, url: string, body: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = 1;

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('CDP fetch timed out after 30s'));
    }, 30000);

    ws.onopen = () => {
      const fetchScript = `
        (function() {
          var csrf = (document.cookie.match(/ct0=([^;]+)/) || [])[1] || '';
          return fetch(${JSON.stringify(url)}, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'authorization': 'Bearer ${BEARER_TOKEN}',
              'x-csrf-token': csrf,
              'x-twitter-auth-type': 'OAuth2Session',
              'x-twitter-active-user': 'yes',
              'x-twitter-client-language': 'en',
            },
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
      `;

      ws.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: {
          expression: fetchScript,
          awaitPromise: true,
          returnByValue: true,
        },
      }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(typeof event.data === 'string' ? event.data : '');
        if (msg.id === id) {
          clearTimeout(timeout);
          ws.close();

          if (msg.error) {
            reject(new Error(`CDP error: ${msg.error.message}`));
            return;
          }

          const value = msg.result?.result?.value;
          if (!value) {
            reject(new Error('Empty CDP response'));
            return;
          }

          const parsed = typeof value === 'string' ? JSON.parse(value) : value;
          if (parsed.__error) {
            if (parsed.__status === 403 || parsed.__status === 401) {
              reject(new SessionExpiredError('Twitter session has expired.'));
            } else {
              reject(new Error(parsed.__message ?? `HTTP ${parsed.__status}: ${parsed.__body ?? ''}`));
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
      reject(new SessionExpiredError('CDP connection failed.'));
    };
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PostTweetResult {
  tweetId: string;
  text: string;
  url: string;
}

export async function postTweet(text: string): Promise<PostTweetResult> {
  requireSession();

  const wsUrl = await findTwitterTab();
  const url = `https://x.com/i/api/graphql/${CREATE_TWEET_QUERY_ID}/CreateTweet`;
  const body = JSON.stringify({
    variables: {
      tweet_text: text,
      dark_request: false,
      media: {
        media_entities: [],
        possibly_sensitive: false,
      },
      semantic_annotation_ids: [],
      disallowed_reply_options: null,
    },
    features: CREATE_TWEET_FEATURES,
    queryId: CREATE_TWEET_QUERY_ID,
  });

  const json = (await cdpFetch(wsUrl, url, body)) as {
    data?: {
      create_tweet?: {
        tweet_results?: {
          result?: {
            rest_id?: string;
            core?: {
              user_results?: {
                result?: {
                  core?: {
                    screen_name?: string;
                  };
                  legacy?: {
                    screen_name?: string;
                  };
                };
              };
            };
          };
        };
      };
    };
    errors?: Array<{ message: string }>;
  };

  if (json.errors?.length) {
    const msgs = json.errors.map(e => e.message).join('; ');
    throw new Error(`Twitter API errors: ${msgs}`);
  }

  const result = json.data?.create_tweet?.tweet_results?.result;
  if (!result?.rest_id) {
    throw new Error('Unexpected response: no tweet ID returned');
  }

  const screenName =
    result.core?.user_results?.result?.legacy?.screen_name ??
    result.core?.user_results?.result?.core?.screen_name ??
    'i';

  return {
    tweetId: result.rest_id,
    text,
    url: `https://x.com/${screenName}/status/${result.rest_id}`,
  };
}
