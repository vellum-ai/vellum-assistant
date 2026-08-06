/**
 * Telegram webhook health sweep.
 *
 * When the public ingress URL behind the Telegram webhook stops working (dead
 * tunnel, rotated ngrok URL, changed gateway route), Telegram keeps accepting
 * updates and queueing them, and nothing on our side notices: the gateway
 * registers the webhook (`telegram/webhook-manager.ts`) but never re-reads it,
 * so the channel goes dark indefinitely. Telegram itself reports the failure
 * via `getWebhookInfo`; this sweep polls that and tells the guardian.
 *
 * Detection only — the sweep never calls `setWebhook`. Re-registration stays
 * with the gateway reconciler, which already fires on credential change,
 * ingress-config change, and system wake. Auto-repairing from here would fight
 * a user mid-setup, and in the common case (a rotated tunnel URL that config
 * still points at) re-registering would just re-register the same dead URL.
 *
 * ## Why recency, not presence
 *
 * `last_error_date` is documented as "Unix time for the most recent error that
 * happened when trying to deliver an update via webhook"
 * (https://core.telegram.org/bots/api#webhookinfo). Telegram does not document
 * clearing it on recovery, and in practice it persists — so its mere presence
 * is NOT evidence of a current outage. A bot that had one blip last month would
 * alert forever. We therefore treat the webhook as failing only when the most
 * recent error is inside `ERROR_RECENCY_WINDOW_MS`.
 *
 * Known limitation: Telegram only produces delivery errors when it has
 * something to deliver. A dead webhook on a channel with no inbound traffic
 * stops refreshing `last_error_date` and reads as healthy here. That is the
 * benign case — nobody is being dropped — and the first message that does
 * arrive re-arms the error, so the next sweep catches it.
 *
 * ## Why its own timer rather than the heartbeat
 *
 * The credential-health check rides `HeartbeatService.executeRun`, which is
 * gated by active hours, `maxConsecutiveRuns`, and `maxDailyRuns`. Those gates
 * exist to stop burning LLM tokens while the guardian is away, and
 * `maxConsecutiveRuns` resets only when the guardian sends a message. A
 * guardian whose only channel is the broken one can't send that message, so
 * riding the heartbeat would mute this check exactly when it matters most.
 * One unauthenticated-cost HTTP GET has none of that token pressure, so it runs
 * on its own interval alongside the other daemon sweeps.
 *
 * That choice carries an obligation: AGENTS.md ("No LLM Work at Daemon
 * Startup") bars LLM providers from unconditional timers and exempts the
 * heartbeat, and this sweep gave up that exemption. So the alert deliberately
 * takes the decision engine's verbatim pass-through — see notifyWebhookFailure.
 * Anything added here that reaches an LLM has to re-answer that rule.
 */

import { z } from "zod";

import { getConfig } from "../config/loader.js";
import { hasWebhookRoutingConfigured } from "../config/webhook-routing.js";
import { getDbMigrationReadiness } from "../daemon/daemon-readiness.js";
import { emitNotificationSignal } from "../notifications/emit-signal.js";
import { credentialKey } from "../security/credential-key.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";
import { getLogger } from "../util/logger.js";
import { getTelegramBotUsername } from "./bot-username.js";

const log = getLogger("telegram-webhook-health");

/** Timeout for the `getWebhookInfo` call. */
const REQUEST_TIMEOUT_MS = 10_000;

/** How often the sweep polls Telegram. */
export const HEALTH_CHECK_INTERVAL_MS = 5 * 60_000;

/**
 * How recent a delivery error must be to count as an ongoing outage.
 *
 * Deliberately several sweep intervals wide: an error that lands just after a
 * poll must still be recent enough to catch on the following poll, and a
 * webhook Telegram is actively retrying refreshes the timestamp continuously.
 */
const ERROR_RECENCY_WINDOW_MS = 15 * 60_000;

// ── Types ─────────────────────────────────────────────────────────────

export type TelegramWebhookHealthStatus =
  /**
   * Telegram holds the URL the reconciler last registered, and reports no
   * recent delivery error. This is the only status that may be presented as
   * confirmed delivery.
   */
  | "healthy"
  /** Telegram holds no webhook URL at all — the channel is definitively dark. */
  | "not_registered"
  /**
   * Telegram holds a webhook URL, but not the one the reconciler registered.
   * A stale tunnel address or another deployment's callback delivers to
   * somewhere this assistant is not listening, which reads identically to a
   * healthy channel until someone sends a message. This is the case
   * `last_error_date` cannot see on a quiet channel (see the module header's
   * known limitation).
   */
  | "url_mismatch"
  /** Telegram reported a delivery error inside the recency window. */
  | "delivery_failing"
  /**
   * A webhook is registered and not erroring, but the reconciler has not
   * recorded which URL it registered, so ownership cannot be established.
   * Expected transiently between the credential save and reconciliation, and
   * persistently for deployments whose last registration predates recording.
   * Distinct from `healthy` because "no fault found" is not "verified".
   */
  | "unverified"
  /** Preconditions unmet (no bot token / no webhook routing) — nothing to check. */
  | "skipped"
  /** Telegram was unreachable or answered unusably — health is unknown. */
  | "unknown";

export interface TelegramWebhookHealthResult {
  status: TelegramWebhookHealthStatus;
  /** Human-readable explanation, safe to log and to show the guardian. */
  detail: string;
  lastErrorMessage?: string;
  lastErrorDate?: number;
  pendingUpdateCount?: number;
  /** The URL Telegram currently holds, when one is registered. */
  registeredUrl?: string;
  /** The URL the reconciler recorded, when it has recorded one. */
  expectedUrl?: string;
}

/**
 * Tolerant schema for the `getWebhookInfo` envelope. Every field is optional
 * so an added or retyped field can't turn a health check into a crash — a
 * field that fails to parse collapses to `undefined` and is treated as absent.
 */
const WebhookInfoResponseSchema = z.object({
  ok: z.boolean().optional().catch(undefined),
  description: z.string().optional().catch(undefined),
  result: z
    .object({
      url: z.string().optional().catch(undefined),
      pending_update_count: z.number().optional().catch(undefined),
      last_error_date: z.number().optional().catch(undefined),
      last_error_message: z.string().optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
});

// ── Detection ─────────────────────────────────────────────────────────

/**
 * Honor `telegram.apiBaseUrl` like the gateway's Telegram client does — a
 * deployment pointed at a proxy or a local mock must not have its health
 * checked against the real api.telegram.org.
 */
function telegramApiBaseUrl(): string {
  try {
    return getConfig().telegram.apiBaseUrl.replace(/\/+$/, "");
  } catch {
    return "https://api.telegram.org";
  }
}

/**
 * The webhook URL the gateway reconciler recorded on its last successful
 * `setWebhook`, or undefined when it has never recorded one.
 *
 * This is deliberately a stored fact rather than a re-derivation. The gateway
 * and the assistant already maintain mirrored copies of the routing tier order
 * (`resolveExpectedTelegramWebhookUrl` and `hasWebhookRoutingConfigured`, which
 * cross-reference each other in comments after LUM-2899), and a third copy here
 * would be a third thing to keep in agreement. It also lets the managed path be
 * checked at all: resolving a platform callback URL means POSTing a route
 * registration, which a read-only health check must not do.
 */
function recordedWebhookUrl(): string | undefined {
  try {
    const recorded = getConfig().telegram.registeredWebhookUrl;
    const trimmed = recorded?.trim();
    return trimmed ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

/** Name the channel concretely when the bot username is known. */
function channelLabel(): string {
  const username = getTelegramBotUsername();
  return username ? `Telegram (@${username.replace(/^@/, "")})` : "Telegram";
}

/**
 * The remediation path, which differs by deployment. Self-hosted users own the
 * ingress URL; platform-managed callback routes are registered for them.
 */
function fixPath(usesManagedCallbacks: boolean): string {
  if (usesManagedCallbacks) {
    return (
      "This deployment uses platform-managed callback routes, so the webhook URL is not yours to set — " +
      "if it stays broken, contact support."
    );
  }
  return (
    "Check that your public ingress URL is reachable (an ngrok free-tier tunnel gets a new URL every restart), " +
    "then point config at the current one with `assistant config set ingress.publicBaseUrl <url>`. " +
    "The gateway re-registers the Telegram webhook whenever that value changes."
  );
}

/**
 * Read Telegram's own view of the webhook and classify it. Performs no
 * notification and mutates no state — `runTelegramWebhookHealthCheck` layers
 * alerting on top.
 */
export async function checkTelegramWebhookHealth(): Promise<TelegramWebhookHealthResult> {
  const botToken = await getSecureKeyAsync(
    credentialKey("telegram", "bot_token"),
  );
  if (!botToken) {
    return {
      status: "skipped",
      detail: "No Telegram bot token configured — webhook check not applicable",
    };
  }

  // Both credentials, matching the gateway reconciler and the readiness probe.
  // `reconcileTelegramWebhook` returns before calling setWebhook when the
  // secret is absent, so a bot_token-only workspace (manual credential import,
  // a half-finished CLI setup) has no webhook by design. Alerting there would
  // report a real absence with the wrong cause and the wrong fix — an ingress
  // URL the user has not got to yet.
  const webhookSecret = await getSecureKeyAsync(
    credentialKey("telegram", "webhook_secret"),
  );
  if (!webhookSecret) {
    return {
      status: "skipped",
      detail:
        "Telegram webhook secret is not configured — registration has not been completed, so there is no webhook to check",
    };
  }

  const { configured, usesManagedCallbacks } =
    await hasWebhookRoutingConfigured(true);
  if (!configured) {
    return {
      status: "skipped",
      detail:
        "No public ingress URL or managed callback route configured — no Telegram webhook is expected",
    };
  }

  let payload: unknown;
  try {
    const response = await fetch(
      `${telegramApiBaseUrl()}/bot${botToken}/getWebhookInfo`,
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );
    if (!response.ok) {
      return {
        status: "unknown",
        detail: `Telegram getWebhookInfo returned HTTP ${response.status}`,
      };
    }
    payload = await response.json();
  } catch (err) {
    // Network error or timeout. Our own connectivity being down is not
    // evidence that the webhook is broken, so this must not alert.
    return {
      status: "unknown",
      detail: `Could not reach Telegram getWebhookInfo: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  const parsed = WebhookInfoResponseSchema.safeParse(payload);
  const info = parsed.success ? parsed.data.result : undefined;
  if (!info) {
    return {
      status: "unknown",
      detail: "Telegram getWebhookInfo returned an unexpected response shape",
    };
  }

  const pendingUpdateCount = info.pending_update_count;
  const label = channelLabel();

  if (!info.url || info.url.trim().length === 0) {
    return {
      status: "not_registered",
      detail:
        `${label} has no webhook registered with Telegram, so inbound messages are not reaching ` +
        `the assistant. ${fixPath(usesManagedCallbacks)}`,
      ...(pendingUpdateCount !== undefined ? { pendingUpdateCount } : {}),
    };
  }

  const registeredUrl = info.url.trim();
  const expectedUrl = recordedWebhookUrl();

  // Ownership is checked before delivery errors on purpose. When Telegram is
  // pointed somewhere we never registered, any error it reports describes
  // delivery to that other destination, so reporting the error would name a
  // symptom while the mismatch is the cause, and the two have different fixes
  // (re-run reconciliation vs. investigate a reachable ingress).
  if (expectedUrl && registeredUrl !== expectedUrl) {
    return {
      status: "url_mismatch",
      detail:
        `${label} is registered with Telegram at a different address than this assistant ` +
        `last registered, so its messages are being delivered somewhere this assistant is not ` +
        `listening. ${fixPath(usesManagedCallbacks)}`,
      registeredUrl,
      expectedUrl,
      ...(pendingUpdateCount !== undefined ? { pendingUpdateCount } : {}),
    };
  }

  const lastErrorDate = info.last_error_date;
  const errorIsRecent =
    lastErrorDate !== undefined &&
    Date.now() - lastErrorDate * 1000 <= ERROR_RECENCY_WINDOW_MS;

  if (errorIsRecent) {
    const reported = info.last_error_message ?? "no error message reported";
    const queued =
      pendingUpdateCount && pendingUpdateCount > 0
        ? ` ${pendingUpdateCount} update(s) are queued and undelivered.`
        : "";
    return {
      status: "delivery_failing",
      detail:
        `${label} cannot receive messages: Telegram reported "${reported}" while delivering to the ` +
        `webhook.${queued} ${fixPath(usesManagedCallbacks)}`,
      ...(info.last_error_message
        ? { lastErrorMessage: info.last_error_message }
        : {}),
      lastErrorDate,
      ...(pendingUpdateCount !== undefined ? { pendingUpdateCount } : {}),
    };
  }

  if (!expectedUrl) {
    // A webhook is registered and quiet, but nothing recorded which URL we
    // registered, so this cannot be distinguished from a stranger's webhook
    // that happens not to be erroring. Reporting "healthy" here is the
    // overclaim this status exists to prevent.
    return {
      status: "unverified",
      detail:
        `${label} has a webhook registered with Telegram and reports no recent delivery errors, ` +
        `but this assistant has no record of registering it, so it cannot confirm the messages ` +
        `reach here. Re-running setup records the registration.`,
      registeredUrl,
      ...(lastErrorDate !== undefined ? { lastErrorDate } : {}),
      ...(pendingUpdateCount !== undefined ? { pendingUpdateCount } : {}),
    };
  }

  return {
    status: "healthy",
    detail: `${label} is registered at the address this assistant last set, and Telegram reports no recent delivery errors`,
    registeredUrl,
    expectedUrl,
    ...(lastErrorDate !== undefined ? { lastErrorDate } : {}),
    ...(pendingUpdateCount !== undefined ? { pendingUpdateCount } : {}),
  };
}

// ── Alerting ──────────────────────────────────────────────────────────

/**
 * Episode latch: the dedupe key of the outage currently in progress, or `null`
 * when the webhook is believed healthy.
 *
 * One alert per outage. It clears only on an observed-healthy poll, so an
 * ongoing failure stays quiet no matter how many times we poll it or how the
 * error message changes mid-outage, and a genuinely new outage after a
 * recovery alerts again.
 *
 * In-memory by design: a daemon restart re-alerts once for an outage that is
 * still ongoing, which is the behaviour we want — a fresh boot should tell the
 * guardian the channel is still dark.
 */
let alertedEpisodeKey: string | null = null;

/**
 * Monotonic episode counter. The dedupe key can't be the episode's timestamp
 * alone: a fail → recover → fail sequence inside one millisecond would reuse
 * the key and the notification pipeline would silently swallow the second
 * outage's alert.
 */
let episodeSeq = 0;

/** Test-only: clear the episode latch between cases. */
export function _resetTelegramWebhookHealthState(): void {
  alertedEpisodeKey = null;
  episodeSeq = 0;
}

async function notifyWebhookFailure(
  result: TelegramWebhookHealthResult,
  dedupeKey: string,
): Promise<void> {
  const title =
    result.status === "not_registered"
      ? "Telegram webhook is not registered"
      : "Telegram webhook is failing";

  await emitNotificationSignal({
    sourceEventName: "telegram.webhook_health_alert",
    // Deliberately NOT "telegram": the Telegram channel is precisely the one
    // that can't be relied on to carry this news.
    //
    // "assistant_tool" specifically (rather than "watcher") is what takes the
    // decision engine's verbatim pass-through: paired with requestedMessage
    // below, evaluateSignal skips the LLM classifier entirely. That matters
    // twice over. AGENTS.md ("No LLM Work at Daemon Startup") forbids invoking
    // LLM providers from unconditional timers, and this sweep is one — the
    // heartbeat's exemption does not extend to it. And the copy here is fully
    // computed already, so a classifier could only re-render it, or decide
    // shouldNotify: false and suppress a high-urgency outage alert outright.
    // background-job-runner.ts uses the same channel for the same reason.
    sourceChannel: "assistant_tool",
    sourceContextId: "telegram-webhook-health",
    // Keyed to the episode, not the error text: a redundant emit inside one
    // outage collapses, while the next outage gets a fresh key and alerts.
    dedupeKey,
    // emitNotificationSignal swallows pipeline errors and resolves with
    // `dispatched: false` unless this is set. Without it the catch in
    // runTelegramWebhookHealthCheck can never fire, and a failed emit would
    // latch the episode forever with the guardian never told.
    throwOnError: true,
    attentionHints: {
      requiresAction: true,
      urgency: "high",
      isAsyncBackground: true,
      visibleInSourceNow: false,
    },
    contextPayload: {
      channel: "telegram",
      status: result.status,
      // requestedTitle/requestedMessage are the pass-through's contract; title
      // and body are what the home-feed writer reads. Both carry the same
      // already-composed copy.
      requestedTitle: title,
      requestedMessage: result.detail,
      title,
      body: result.detail,
      ...(result.lastErrorMessage
        ? { lastErrorMessage: result.lastErrorMessage }
        : {}),
      ...(result.lastErrorDate ? { lastErrorDate: result.lastErrorDate } : {}),
      ...(result.pendingUpdateCount !== undefined
        ? { pendingUpdateCount: result.pendingUpdateCount }
        : {}),
    },
    routingIntent: "single_channel",
    conversationMetadata: {
      source: "telegram-webhook-health",
      groupId: "system:background",
      conversationType: "background",
    },
  });
}

/**
 * Run one health round: check, then alert on the transition into failure.
 * Returns the result so callers and tests can assert on it.
 */
export async function runTelegramWebhookHealthCheck(): Promise<TelegramWebhookHealthResult> {
  const result = await checkTelegramWebhookHealth();

  // Neither evidence of health nor of failure — leave the latch as-is so an
  // unreachable Telegram (or a channel that isn't set up) can't either raise a
  // false alarm or silently clear a real one.
  //
  // `unverified` belongs here rather than with the failures below: a webhook
  // that is registered and quiet, on a deployment that never recorded its
  // registration, is unproven, not broken. Alerting on it would page the
  // guardian about every install whose last reconciliation predates URL
  // recording. Note the asymmetry with `url_mismatch`, which falls through to
  // the alert: there we know the address is wrong, which is a fault.
  if (
    result.status === "skipped" ||
    result.status === "unknown" ||
    result.status === "unverified"
  ) {
    log.debug({ status: result.status }, result.detail);
    return result;
  }

  if (result.status === "healthy") {
    if (alertedEpisodeKey !== null) {
      log.info(
        { episode: alertedEpisodeKey },
        "Telegram webhook recovered — clearing alert latch",
      );
      alertedEpisodeKey = null;
    }
    return result;
  }

  if (alertedEpisodeKey !== null) {
    log.debug(
      { status: result.status, episode: alertedEpisodeKey },
      "Telegram webhook still failing — guardian already alerted for this outage",
    );
    return result;
  }

  // Latch before awaiting the emit so an overlapping round can't double-fire.
  episodeSeq++;
  const dedupeKey = `telegram-webhook-health:${Date.now()}:${episodeSeq}`;
  alertedEpisodeKey = dedupeKey;
  log.warn({ status: result.status }, result.detail);

  try {
    await notifyWebhookFailure(result, dedupeKey);
  } catch (err) {
    // The guardian was never told, so this outage is still un-alerted. Release
    // the latch and let the next round try again.
    //
    // Only thrown failures release it. A signal the pipeline deliberately
    // suppresses (deterministic checks returning `dispatched: false` without
    // throwing) keeps the latch, on purpose: releasing it would mint a fresh
    // episode key next round and re-emit every 5 minutes for as long as the
    // suppression held. Staying quiet is the better failure mode, and matches
    // how credential-health alerts behave.
    alertedEpisodeKey = null;
    log.error({ err }, "Failed to emit Telegram webhook health notification");
  }

  return result;
}

// ── Sweep lifecycle ───────────────────────────────────────────────────

let sweepTimer: ReturnType<typeof setInterval> | null = null;
let sweepInProgress = false;

/**
 * Start the periodic Telegram webhook health sweep. Idempotent — calling it
 * multiple times reuses the same timer.
 */
export function startTelegramWebhookHealthSweep(): void {
  if (sweepTimer) {
    return;
  }
  sweepTimer = setInterval(() => {
    if (sweepInProgress) {
      return;
    }
    // Alerting writes a notification event, so the round is pointless (and
    // noisy) while the schema is unusable. Sweeps also start in the failed
    // degraded mode, where the DB is open but may be mid-migration-repair.
    if (!getDbMigrationReadiness().ready) {
      return;
    }
    sweepInProgress = true;
    void runTelegramWebhookHealthCheck()
      .catch((err) => {
        log.error({ err }, "Telegram webhook health sweep failed");
      })
      .finally(() => {
        sweepInProgress = false;
      });
  }, HEALTH_CHECK_INTERVAL_MS);
}

/** Stop the periodic sweep. Used in tests and shutdown. */
export function stopTelegramWebhookHealthSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  sweepInProgress = false;
}
