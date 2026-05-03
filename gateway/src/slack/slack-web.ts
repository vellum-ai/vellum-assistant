import { fetchImpl } from "../fetch.js";
import { getLogger } from "../logger.js";

const log = getLogger("slack-web");

/**
 * Subset of the Slack `conversations.history` / `conversations.replies`
 * message payload that the gateway needs for catch-up. Synthesized
 * Socket Mode envelopes are built by mapping these fields onto the
 * `app_mention` / `message` event shapes that the live path already
 * understands.
 */
export type SlackHistoryMessage = {
  type?: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  team?: string;
  blocks?: unknown[];
  files?: unknown[];
  attachments?: unknown[];
  edited?: { user?: string; ts?: string };
};

type SlackHistoryResponse = {
  ok: boolean;
  error?: string;
  messages?: SlackHistoryMessage[];
  has_more?: boolean;
};

export type FetchSlackHistoryResult = {
  /** Messages returned by Slack. Empty on transient failure. */
  messages: SlackHistoryMessage[];
  /** True when Slack indicates additional pages are available. */
  hasMore: boolean;
  /**
   * `true` when the call succeeded (HTTP 200 + `ok: true`). False results
   * are logged and silently treated as zero messages so a transient outage
   * during catch-up doesn't block reconnect.
   */
  ok: boolean;
};

/** Slack rate-limit handling — wait this long after a 429 before retrying. */
const RATE_LIMIT_FALLBACK_MS = 5_000;

/**
 * Coordinates per-cycle catch-up cancellation. When any worker hits a 429,
 * it calls `abort()`; remaining workers check `aborted` before each call
 * and bail out without issuing further requests, so the catch-up cycle
 * stops cleanly instead of cascading into more rate-limit responses.
 */
export class CatchupAbortSignal {
  private flag = false;
  abort(): void {
    this.flag = true;
  }
  get aborted(): boolean {
    return this.flag;
  }
}

async function callSlackApi(
  url: string,
  botToken: string,
  abort: CatchupAbortSignal | undefined,
): Promise<SlackHistoryResponse | undefined> {
  if (abort?.aborted) return undefined;

  let resp: Response;
  try {
    resp = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${botToken}` },
    });
  } catch (err) {
    log.warn({ err, url: redact(url) }, "Slack catch-up fetch threw");
    return undefined;
  }

  if (resp.status === 429) {
    const retryHeader = resp.headers.get("retry-after");
    const waitMs = retryHeader
      ? Number.parseInt(retryHeader, 10) * 1_000
      : RATE_LIMIT_FALLBACK_MS;
    abort?.abort();
    log.warn(
      { url: redact(url), waitMs },
      "Slack catch-up rate limited; aborting cycle",
    );
    return undefined;
  }

  if (!resp.ok) {
    log.warn(
      { url: redact(url), status: resp.status },
      "Slack catch-up returned non-OK HTTP status",
    );
    return undefined;
  }

  let data: SlackHistoryResponse;
  try {
    data = (await resp.json()) as SlackHistoryResponse;
  } catch (err) {
    log.warn({ err, url: redact(url) }, "Slack catch-up response not JSON");
    return undefined;
  }

  if (!data.ok) {
    log.warn(
      { url: redact(url), error: data.error },
      "Slack catch-up API returned ok=false",
    );
    return undefined;
  }

  return data;
}

/** Strip the channel/oldest query for log readability. */
function redact(url: string): string {
  const idx = url.indexOf("?");
  return idx >= 0 ? url.slice(0, idx) : url;
}

/**
 * Fetch messages in `channel` strictly newer than `oldest` (Slack ts).
 * `inclusive=false` is the default; we set it explicitly to make the
 * behavior obvious on read. No pagination — we cap at `limit` messages
 * per channel per reconnect to bound API budget.
 */
export async function fetchChannelHistorySince(params: {
  botToken: string;
  channel: string;
  oldest: string;
  limit: number;
  abort?: CatchupAbortSignal;
}): Promise<FetchSlackHistoryResult> {
  const { botToken, channel, oldest, limit, abort } = params;
  const url =
    "https://slack.com/api/conversations.history" +
    `?channel=${encodeURIComponent(channel)}` +
    `&oldest=${encodeURIComponent(oldest)}` +
    `&limit=${limit}` +
    `&inclusive=false`;
  const data = await callSlackApi(url, botToken, abort);
  if (!data) return { messages: [], hasMore: false, ok: false };
  return {
    messages: data.messages ?? [],
    hasMore: data.has_more === true,
    ok: true,
  };
}

/**
 * Fetch replies in a thread strictly newer than `oldest`. Uses
 * `conversations.replies` because it returns a smaller, thread-scoped
 * window than `conversations.history` and avoids re-paging the channel
 * for every active thread on reconnect.
 */
export async function fetchThreadRepliesSince(params: {
  botToken: string;
  channel: string;
  threadTs: string;
  oldest: string;
  limit: number;
  abort?: CatchupAbortSignal;
}): Promise<FetchSlackHistoryResult> {
  const { botToken, channel, threadTs, oldest, limit, abort } = params;
  const url =
    "https://slack.com/api/conversations.replies" +
    `?channel=${encodeURIComponent(channel)}` +
    `&ts=${encodeURIComponent(threadTs)}` +
    `&oldest=${encodeURIComponent(oldest)}` +
    `&limit=${limit}` +
    `&inclusive=false`;
  const data = await callSlackApi(url, botToken, abort);
  if (!data) return { messages: [], hasMore: false, ok: false };
  return {
    messages: data.messages ?? [],
    hasMore: data.has_more === true,
    ok: true,
  };
}

/**
 * Drives a list of async tasks with bounded concurrency. Used to fan out
 * catch-up fetches across channels without flooding Slack's rate limits.
 */
export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= tasks.length) return;
        results[idx] = await tasks[idx]();
      }
    },
  );
  await Promise.all(workers);
  return results;
}
