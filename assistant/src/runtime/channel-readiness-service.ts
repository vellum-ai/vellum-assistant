import { resolveTwilioPhoneNumber } from "../calls/twilio-config.js";
import { hasTwilioCredentials } from "../calls/twilio-rest.js";
import { getChannelInvitePolicy } from "../channels/config.js";
import { loadRawConfig } from "../config/loader.js";
import { getEmailService } from "../email/service.js";
import { getSecureKey } from "../security/secure-keys.js";
import { resolveWhatsAppDisplayNumber } from "./channel-invite-transports/whatsapp.js";
import type {
  ChannelId,
  ChannelProbe,
  ChannelProbeContext,
  ChannelReadinessSnapshot,
  ReadinessCheckResult,
} from "./channel-readiness-types.js";
import { probeLocalGatewayHealth } from "./local-gateway-health.js";

/** Remote check results are cached for 5 minutes before being considered stale. */
export const REMOTE_TTL_MS = 5 * 60 * 1000;

function hasIngressConfigured(): boolean {
  try {
    const raw = loadRawConfig();
    const ingress = (raw?.ingress ?? {}) as Record<string, unknown>;
    const publicBaseUrl = (ingress.publicBaseUrl as string) ?? "";
    const enabled =
      (ingress.enabled as boolean | undefined) ??
      (publicBaseUrl ? true : false);
    return enabled && publicBaseUrl.length > 0;
  } catch {
    return false;
  }
}

// ── Voice Probe ─────────────────────────────────────────────────────────────

const voiceProbe: ChannelProbe = {
  channel: "phone",
  async runLocalChecks(): Promise<ReadinessCheckResult[]> {
    const results: ReadinessCheckResult[] = [];

    const hasCreds = hasTwilioCredentials();
    results.push({
      name: "twilio_credentials",
      passed: hasCreds,
      message: hasCreds
        ? "Twilio credentials are configured"
        : "Twilio Account SID and Auth Token are not configured",
    });

    const resolvedNumber = resolveTwilioPhoneNumber();
    const hasPhone = !!resolvedNumber;
    results.push({
      name: "phone_number",
      passed: hasPhone,
      message: hasPhone
        ? "Phone number is assigned for voice calls"
        : "No phone number assigned for voice calls",
    });

    const hasIngress = hasIngressConfigured();
    results.push({
      name: "ingress",
      passed: hasIngress,
      message: hasIngress
        ? "Public ingress URL is configured"
        : "Public ingress URL is not configured or disabled",
    });

    if (hasIngress) {
      const gatewayHealth = await probeLocalGatewayHealth();
      results.push({
        name: "gateway_health",
        passed: gatewayHealth.healthy,
        message: gatewayHealth.healthy
          ? `Local gateway is serving requests at ${gatewayHealth.target}`
          : `Local gateway is not serving requests at ${gatewayHealth.target}${
              gatewayHealth.error ? `: ${gatewayHealth.error}` : ""
            }`,
      });
    }

    return results;
  },
};

// ── Telegram Probe ──────────────────────────────────────────────────────────

const telegramProbe: ChannelProbe = {
  channel: "telegram",
  runLocalChecks(): ReadinessCheckResult[] {
    const results: ReadinessCheckResult[] = [];

    const hasBotToken = !!getSecureKey("credential:telegram:bot_token");
    results.push({
      name: "bot_token",
      passed: hasBotToken,
      message: hasBotToken
        ? "Telegram bot token is configured"
        : "Telegram bot token is not configured",
    });

    const hasWebhookSecret = !!getSecureKey(
      "credential:telegram:webhook_secret",
    );
    results.push({
      name: "webhook_secret",
      passed: hasWebhookSecret,
      message: hasWebhookSecret
        ? "Telegram webhook secret is configured"
        : "Telegram webhook secret is not configured",
    });

    const hasIngress = hasIngressConfigured();
    results.push({
      name: "ingress",
      passed: hasIngress,
      message: hasIngress
        ? "Public ingress URL is configured"
        : "Public ingress URL is not configured or disabled",
    });

    return results;
  },
  // Telegram has no remote checks currently
};

// ── Email Probe ─────────────────────────────────────────────────────────────

const emailProbe: ChannelProbe = {
  channel: "email",
  runLocalChecks(): ReadinessCheckResult[] {
    const results: ReadinessCheckResult[] = [];

    const hasApiKey = !!(
      getSecureKey("agentmail") || getSecureKey("credential:agentmail:api_key")
    );
    results.push({
      name: "agentmail_api_key",
      passed: hasApiKey,
      message: hasApiKey
        ? "AgentMail API key is configured"
        : "AgentMail API key is not configured",
    });

    const invitePolicy = getChannelInvitePolicy("email");
    results.push({
      name: "invite_policy",
      passed: invitePolicy.codeRedemptionEnabled,
      message: invitePolicy.codeRedemptionEnabled
        ? "Email invite code redemption is enabled"
        : "Email invite code redemption is disabled",
    });

    const hasIngress = hasIngressConfigured();
    results.push({
      name: "ingress",
      passed: hasIngress,
      message: hasIngress
        ? "Public ingress URL is configured"
        : "Public ingress URL is not configured or disabled",
    });

    return results;
  },
  async runRemoteChecks(): Promise<ReadinessCheckResult[]> {
    // Only worth checking if the API key is present
    const hasApiKey = !!(
      getSecureKey("agentmail") || getSecureKey("credential:agentmail:api_key")
    );
    if (!hasApiKey) return [];

    try {
      const address = await getEmailService().getPrimaryInboxAddress();
      const hasInbox = !!address;
      return [
        {
          name: "inbox_configured",
          passed: hasInbox,
          message: hasInbox
            ? `Inbox address is configured (${address})`
            : "No inbox address configured — create one with: assistant email setup inboxes",
        },
      ];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return [
        {
          name: "inbox_configured",
          passed: false,
          message: `Failed to check inbox configuration: ${message}`,
        },
      ];
    }
  },
};

// ── WhatsApp Probe ──────────────────────────────────────────────────────────

const whatsappProbe: ChannelProbe = {
  channel: "whatsapp",
  runLocalChecks(): ReadinessCheckResult[] {
    const results: ReadinessCheckResult[] = [];

    const hasPhoneNumberId = !!getSecureKey(
      "credential:whatsapp:phone_number_id",
    );
    results.push({
      name: "whatsapp_phone_number_id",
      passed: hasPhoneNumberId,
      message: hasPhoneNumberId
        ? "WhatsApp phone number ID is configured"
        : "WhatsApp phone number ID is not configured",
    });

    const hasAccessToken = !!getSecureKey("credential:whatsapp:access_token");
    results.push({
      name: "whatsapp_access_token",
      passed: hasAccessToken,
      message: hasAccessToken
        ? "WhatsApp access token is configured"
        : "WhatsApp access token is not configured",
    });

    const hasAppSecret = !!getSecureKey("credential:whatsapp:app_secret");
    results.push({
      name: "whatsapp_app_secret",
      passed: hasAppSecret,
      message: hasAppSecret
        ? "WhatsApp app secret is configured"
        : "WhatsApp app secret is not configured",
    });

    const hasWebhookVerifyToken = !!getSecureKey(
      "credential:whatsapp:webhook_verify_token",
    );
    results.push({
      name: "whatsapp_webhook_verify_token",
      passed: hasWebhookVerifyToken,
      message: hasWebhookVerifyToken
        ? "WhatsApp webhook verify token is configured"
        : "WhatsApp webhook verify token is not configured",
    });

    const displayNumber = resolveWhatsAppDisplayNumber();
    const hasDisplayNumber = !!displayNumber;
    results.push({
      name: "whatsapp_display_phone_number",
      passed: hasDisplayNumber,
      message: hasDisplayNumber
        ? `WhatsApp display phone number is configured (${displayNumber})`
        : "WhatsApp display phone number is not configured — set whatsapp.phoneNumber in workspace config",
    });

    const invitePolicy = getChannelInvitePolicy("whatsapp");
    results.push({
      name: "invite_policy",
      passed: invitePolicy.codeRedemptionEnabled,
      message: invitePolicy.codeRedemptionEnabled
        ? "WhatsApp invite code redemption is enabled"
        : "WhatsApp invite code redemption is disabled",
    });

    const hasIngress = hasIngressConfigured();
    results.push({
      name: "ingress",
      passed: hasIngress,
      message: hasIngress
        ? "Public ingress URL is configured"
        : "Public ingress URL is not configured or disabled",
    });

    return results;
  },
};

// ── Slack Probe ─────────────────────────────────────────────────────────────

const slackProbe: ChannelProbe = {
  channel: "slack",
  runLocalChecks(): ReadinessCheckResult[] {
    const hasBotToken = !!getSecureKey("credential:slack_channel:bot_token");
    const hasAppToken = !!getSecureKey("credential:slack_channel:app_token");
    return [
      {
        name: "bot_token",
        passed: hasBotToken,
        message: hasBotToken
          ? "Slack bot token is configured"
          : "Slack bot token is not configured",
      },
      {
        name: "app_token",
        passed: hasAppToken,
        message: hasAppToken
          ? "Slack app token is configured"
          : "Slack app token is not configured",
      },
    ];
  },
};

// ── Service ─────────────────────────────────────────────────────────────────

export class ChannelReadinessService {
  private probes = new Map<ChannelId, ChannelProbe>();
  private snapshots = new Map<string, ChannelReadinessSnapshot>();

  registerProbe(probe: ChannelProbe): void {
    this.probes.set(probe.channel, probe);
  }

  /**
   * Get readiness snapshots for the specified channel (or all registered channels).
   * Local checks always run on demand, including async loopback probes. Remote
   * checks run only when `includeRemote` is true and the cache is stale or
   * missing.
   */
  async getReadiness(
    channel?: ChannelId,
    includeRemote?: boolean,
  ): Promise<ChannelReadinessSnapshot[]> {
    const channels = channel ? [channel] : Array.from(this.probes.keys());

    const results: ChannelReadinessSnapshot[] = [];
    for (const ch of channels) {
      const probe = this.probes.get(ch);
      if (!probe) {
        results.push(this.unsupportedSnapshot(ch));
        continue;
      }

      const probeContext: ChannelProbeContext = {};
      const localChecks = await probe.runLocalChecks(probeContext);
      let remoteChecks: ReadinessCheckResult[] | undefined;
      let remoteChecksFreshlyFetched = false;
      let remoteChecksAffectReadiness = false;
      let stale = false;

      const cacheKey = this.snapshotCacheKey(ch);
      const cached = this.snapshots.get(cacheKey);
      const now = Date.now();

      if (includeRemote && probe.runRemoteChecks) {
        const cacheExpired =
          !cached ||
          !cached.remoteChecks ||
          now - cached.checkedAt >= REMOTE_TTL_MS;
        if (cacheExpired) {
          remoteChecks = await probe.runRemoteChecks(probeContext);
          remoteChecksFreshlyFetched = true;
          remoteChecksAffectReadiness = true;
        } else {
          // Reuse cached remote checks
          remoteChecks = cached.remoteChecks;
          remoteChecksAffectReadiness = true;
        }
      } else if (cached?.remoteChecks) {
        // Surface cached remote checks for visibility but never let them affect
        // readiness when the caller explicitly opted out of remote checks.
        remoteChecks = cached.remoteChecks;
        stale = now - cached.checkedAt >= REMOTE_TTL_MS;
        remoteChecksAffectReadiness = false;
      }

      const allLocalPassed = localChecks.every((c) => c.passed);
      const allRemotePassed =
        remoteChecks && remoteChecksAffectReadiness
          ? remoteChecks.every((c) => c.passed)
          : true;
      const ready = allLocalPassed && allRemotePassed;

      const reasons: Array<{ code: string; text: string }> = [];
      for (const check of localChecks) {
        if (!check.passed) {
          reasons.push({ code: check.name, text: check.message });
        }
      }
      if (remoteChecks && remoteChecksAffectReadiness) {
        for (const check of remoteChecks) {
          if (!check.passed) {
            reasons.push({ code: check.name, text: check.message });
          }
        }
      }

      const snapshot: ChannelReadinessSnapshot = {
        channel: ch,
        ready,
        checkedAt:
          remoteChecks && cached && !remoteChecksFreshlyFetched
            ? cached.checkedAt
            : now,
        stale,
        reasons,
        localChecks,
        remoteChecks,
      };

      this.snapshots.set(cacheKey, snapshot);
      results.push(snapshot);
    }

    return results;
  }

  /** Clear cached snapshot for a specific channel, forcing re-evaluation on next call. */
  invalidateChannel(channel: ChannelId): void {
    const prefix = `${channel}::`;
    for (const key of this.snapshots.keys()) {
      if (key.startsWith(prefix)) {
        this.snapshots.delete(key);
      }
    }
  }

  /** Clear all cached snapshots. */
  invalidateAll(): void {
    this.snapshots.clear();
  }

  private unsupportedSnapshot(channel: ChannelId): ChannelReadinessSnapshot {
    return {
      channel,
      ready: false,
      checkedAt: Date.now(),
      stale: false,
      reasons: [
        {
          code: "unsupported_channel",
          text: `Channel ${channel} is not supported`,
        },
      ],
      localChecks: [],
    };
  }

  private snapshotCacheKey(channel: ChannelId): string {
    return `${channel}::__default__`;
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

/** Create a service instance with built-in Voice, Telegram, Email, WhatsApp, and Slack probes registered. */
export function createReadinessService(): ChannelReadinessService {
  const service = new ChannelReadinessService();
  service.registerProbe(voiceProbe);
  service.registerProbe(telegramProbe);
  service.registerProbe(emailProbe);
  service.registerProbe(whatsappProbe);
  service.registerProbe(slackProbe);
  return service;
}
