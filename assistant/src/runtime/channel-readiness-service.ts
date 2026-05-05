import {
  normalizePublicBaseUrl,
  resolveTwilioPublicBaseUrl,
} from "@vellumai/service-contracts/twilio-ingress";

import { resolveTwilioPhoneNumber } from "../calls/twilio-config.js";
import { hasTwilioCredentials } from "../calls/twilio-rest.js";
import { getChannelInvitePolicy } from "../channels/config.js";
import { getIsPlatform } from "../config/env-registry.js";
import { getConfig, getNestedValue, loadRawConfig } from "../config/loader.js";
import { isEmailEnabled } from "../email/feature-gate.js";
import { credentialKey } from "../security/credential-key.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";
import { resolveWhatsAppDisplayNumber } from "./channel-invite-transports/whatsapp.js";
import type {
  ChannelId,
  ChannelProbe,
  ChannelProbeContext,
  ChannelReadinessSnapshot,
  ReadinessCheckResult,
  SetupStatus,
} from "./channel-readiness-types.js";

/** Remote check results are cached for 5 minutes before being considered stale. */
export const REMOTE_TTL_MS = 5 * 60 * 1000;

function hasIngressConfigured(options: { twilio?: boolean } = {}): boolean {
  try {
    const raw = loadRawConfig();
    const ingress = (raw?.ingress ?? {}) as Record<string, unknown>;
    const effectiveBaseUrl = options.twilio
      ? (resolveTwilioPublicBaseUrl(ingress) ?? "")
      : (normalizePublicBaseUrl(ingress.publicBaseUrl) ?? "");
    const enabled =
      (ingress.enabled as boolean | undefined) ??
      (effectiveBaseUrl ? true : false);
    return enabled && effectiveBaseUrl.trim().length > 0;
  } catch {
    return false;
  }
}

function hasWebhookRoutingConfigured(
  allowManagedCallbacks = false,
  options: { twilio?: boolean } = {},
): {
  configured: boolean;
  usesManagedCallbacks: boolean;
} {
  const ingressConfigured = hasIngressConfigured(options);
  if (ingressConfigured) {
    return { configured: true, usesManagedCallbacks: false };
  }

  const usesManagedCallbacks = allowManagedCallbacks && getIsPlatform();
  return {
    configured: usesManagedCallbacks,
    usesManagedCallbacks,
  };
}

// ── Shared check helpers ────────────────────────────────────────────────────

/** Build a check result from a boolean condition. */
function check(
  name: string,
  passed: boolean,
  passMessage: string,
  failMessage: string,
): ReadinessCheckResult {
  return { name, passed, message: passed ? passMessage : failMessage };
}

/** Check that a secure credential key exists. */
async function checkCredential(
  name: string,
  service: string,
  field: string,
  label: string,
): Promise<ReadinessCheckResult> {
  const exists = !!(await getSecureKeyAsync(credentialKey(service, field)));
  return check(
    name,
    exists,
    `${label} is configured`,
    `${label} is not configured`,
  );
}

/** Check that public ingress is configured and enabled. */
function checkIngress(
  allowManagedCallbacks = false,
  options: { twilio?: boolean } = {},
): ReadinessCheckResult {
  const { configured, usesManagedCallbacks } = hasWebhookRoutingConfigured(
    allowManagedCallbacks,
    options,
  );
  return check(
    "ingress",
    configured,
    usesManagedCallbacks
      ? "Managed platform callback routing is configured"
      : options.twilio
        ? "Twilio public ingress URL is configured"
        : "Public ingress URL is configured",
    allowManagedCallbacks
      ? options.twilio
        ? "No Twilio public ingress URL or managed callback route is configured"
        : "No public ingress URL or managed callback route is configured"
      : options.twilio
        ? "Twilio public ingress URL is not configured or disabled"
        : "Public ingress URL is not configured or disabled",
  );
}

// ── Voice Probe ─────────────────────────────────────────────────────────────

const voiceProbe: ChannelProbe = {
  channel: "phone",
  async runLocalChecks(): Promise<ReadinessCheckResult[]> {
    const hasCreds = await hasTwilioCredentials();
    const hasPhone = !!resolveTwilioPhoneNumber();
    const ingress = checkIngress(true, { twilio: true });

    return [
      check(
        "twilio_credentials",
        hasCreds,
        "Twilio credentials are configured",
        "Twilio Account SID and Auth Token are not configured",
      ),
      check(
        "phone_number",
        hasPhone,
        "Phone number is assigned for voice calls",
        "No phone number assigned for voice calls",
      ),
      ingress,
    ];
  },
};

// ── Telegram Probe ──────────────────────────────────────────────────────────

const telegramProbe: ChannelProbe = {
  channel: "telegram",
  async runLocalChecks(): Promise<ReadinessCheckResult[]> {
    return [
      await checkCredential(
        "bot_token",
        "telegram",
        "bot_token",
        "Telegram bot token",
      ),
      await checkCredential(
        "webhook_secret",
        "telegram",
        "webhook_secret",
        "Telegram webhook secret",
      ),
      checkIngress(true),
    ];
  },
};

// ── Email Probe ─────────────────────────────────────────────────────────────

const emailProbe: ChannelProbe = {
  channel: "email",
  async runLocalChecks(): Promise<ReadinessCheckResult[]> {
    const invitePolicy = getChannelInvitePolicy("email");
    return [
      check(
        "platform_email",
        true,
        "Email is handled through the platform (Mailgun)",
        "Email requires platform registration",
      ),
      check(
        "invite_policy",
        invitePolicy.codeRedemptionEnabled,
        "Email invite code redemption is enabled",
        "Email invite code redemption is disabled",
      ),
      checkIngress(),
    ];
  },
  async runRemoteChecks(): Promise<ReadinessCheckResult[]> {
    try {
      const raw = loadRawConfig();
      const address = getNestedValue(raw, "email.address");
      const hasInbox = typeof address === "string" && address.length > 0;
      return [
        {
          name: "inbox_configured",
          passed: hasInbox,
          message: hasInbox
            ? `Inbox address is configured (${address})`
            : "No inbox address configured — register one with: assistant email register <username>",
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
  async runLocalChecks(): Promise<ReadinessCheckResult[]> {
    const displayNumber = resolveWhatsAppDisplayNumber();
    const invitePolicy = getChannelInvitePolicy("whatsapp");
    return [
      await checkCredential(
        "whatsapp_phone_number_id",
        "whatsapp",
        "phone_number_id",
        "WhatsApp phone number ID",
      ),
      await checkCredential(
        "whatsapp_access_token",
        "whatsapp",
        "access_token",
        "WhatsApp access token",
      ),
      await checkCredential(
        "whatsapp_app_secret",
        "whatsapp",
        "app_secret",
        "WhatsApp app secret",
      ),
      await checkCredential(
        "whatsapp_webhook_verify_token",
        "whatsapp",
        "webhook_verify_token",
        "WhatsApp webhook verify token",
      ),
      check(
        "whatsapp_display_phone_number",
        !!displayNumber,
        `WhatsApp display phone number is configured (${displayNumber})`,
        "WhatsApp display phone number is not configured — set whatsapp.phoneNumber in workspace config",
      ),
      check(
        "invite_policy",
        invitePolicy.codeRedemptionEnabled,
        "WhatsApp invite code redemption is enabled",
        "WhatsApp invite code redemption is disabled",
      ),
      checkIngress(),
    ];
  },
};

// ── Slack Probe ─────────────────────────────────────────────────────────────

const slackProbe: ChannelProbe = {
  channel: "slack",
  async runLocalChecks(): Promise<ReadinessCheckResult[]> {
    return [
      await checkCredential(
        "bot_token",
        "slack_channel",
        "bot_token",
        "Slack bot token",
      ),
      await checkCredential(
        "app_token",
        "slack_channel",
        "app_token",
        "Slack app token",
      ),
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

      // setupStatus: considers all checks (credentials + infrastructure)
      const consideredChecks = [
        ...localChecks,
        ...(remoteChecks && remoteChecksAffectReadiness ? remoteChecks : []),
      ];
      const anyCheckPassed = consideredChecks.some((c) => c.passed);
      const setupStatus: SetupStatus = !anyCheckPassed
        ? "not_configured"
        : ready
          ? "ready"
          : "incomplete";

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
        setupStatus,
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
      setupStatus: "not_configured",
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
  if (isEmailEnabled(getConfig())) {
    service.registerProbe(emailProbe);
  }
  service.registerProbe(whatsappProbe);
  service.registerProbe(slackProbe);
  return service;
}
