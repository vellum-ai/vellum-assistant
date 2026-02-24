import type {
  ChannelId,
  ChannelProbe,
  ChannelProbeContext,
  ChannelReadinessSnapshot,
  ReadinessCheckResult,
} from './channel-readiness-types.js';
import {
  hasTwilioCredentials,
  getTollFreeVerificationStatus,
  getPhoneNumberSid,
} from '../calls/twilio-rest.js';
import { getSecureKey } from '../security/secure-keys.js';
import { loadRawConfig } from '../config/loader.js';

/** Remote check results are cached for 5 minutes before being considered stale. */
export const REMOTE_TTL_MS = 5 * 60 * 1000;

// ── SMS Probe ───────────────────────────────────────────────────────────────

function hasIngressConfigured(): boolean {
  try {
    const raw = loadRawConfig();
    const ingress = (raw?.ingress ?? {}) as Record<string, unknown>;
    const publicBaseUrl = (ingress.publicBaseUrl as string) ?? '';
    const enabled = (ingress.enabled as boolean | undefined) ?? (publicBaseUrl ? true : false);
    return enabled && publicBaseUrl.length > 0;
  } catch {
    return false;
  }
}

function getAssistantMappedPhoneNumber(
  smsConfig: Record<string, unknown>,
  assistantId?: string,
): string | undefined {
  if (!assistantId) return undefined;
  const mapping = (smsConfig.assistantPhoneNumbers as Record<string, string> | undefined) ?? {};
  return mapping[assistantId];
}

function hasAnyAssistantMappedPhoneNumber(smsConfig: Record<string, unknown>): boolean {
  const mapping = (smsConfig.assistantPhoneNumbers as Record<string, string> | undefined) ?? {};
  return Object.keys(mapping).length > 0;
}

function hasAnyAssistantMappedPhoneNumberSafe(): boolean {
  try {
    const raw = loadRawConfig();
    const smsConfig = (raw?.sms ?? {}) as Record<string, unknown>;
    return hasAnyAssistantMappedPhoneNumber(smsConfig);
  } catch {
    return false;
  }
}

/**
 * Resolve SMS from-number with canonical precedence:
 * assistant mapping -> env override -> config sms.phoneNumber -> secure key fallback.
 */
function resolveSmsPhoneNumber(assistantId?: string): string {
  try {
    const raw = loadRawConfig();
    const smsConfig = (raw?.sms ?? {}) as Record<string, unknown>;
    const mapped = getAssistantMappedPhoneNumber(smsConfig, assistantId);
    return mapped
      || process.env.TWILIO_PHONE_NUMBER
      || (smsConfig.phoneNumber as string)
      || getSecureKey('credential:twilio:phone_number')
      || '';
  } catch {
    return process.env.TWILIO_PHONE_NUMBER
      || getSecureKey('credential:twilio:phone_number')
      || '';
  }
}

const smsProbe: ChannelProbe = {
  channel: 'sms',
  runLocalChecks(context?: ChannelProbeContext): ReadinessCheckResult[] {
    const results: ReadinessCheckResult[] = [];

    const hasCreds = hasTwilioCredentials();
    results.push({
      name: 'twilio_credentials',
      passed: hasCreds,
      message: hasCreds
        ? 'Twilio credentials are configured'
        : 'Twilio Account SID and Auth Token are not configured',
    });

    const resolvedNumber = resolveSmsPhoneNumber(context?.assistantId);
    const hasPhone = !!resolvedNumber || (!context?.assistantId && hasAnyAssistantMappedPhoneNumberSafe());
    results.push({
      name: 'phone_number',
      passed: hasPhone,
      message: hasPhone
        ? (context?.assistantId && !resolvedNumber
          ? `Assistant ${context.assistantId} has no direct mapping, but SMS phone numbers are assigned`
          : 'Phone number is assigned')
        : (context?.assistantId
          ? `No phone number assigned for assistant ${context.assistantId}`
          : 'No phone number assigned'),
    });

    const hasIngress = hasIngressConfigured();
    results.push({
      name: 'ingress',
      passed: hasIngress,
      message: hasIngress
        ? 'Public ingress URL is configured'
        : 'Public ingress URL is not configured or disabled',
    });

    return results;
  },
  async runRemoteChecks(context?: ChannelProbeContext): Promise<ReadinessCheckResult[]> {
    if (!hasTwilioCredentials()) return [];

    const accountSid = getSecureKey('credential:twilio:account_sid');
    const authToken = getSecureKey('credential:twilio:auth_token');
    if (!accountSid || !authToken) return [];

    const phoneNumber = resolveSmsPhoneNumber(context?.assistantId);
    if (!phoneNumber) return [];

    // Only toll-free numbers need verification checks
    const tollFreePrefixes = ['+1800', '+1833', '+1844', '+1855', '+1866', '+1877', '+1888'];
    const isTollFree = tollFreePrefixes.some((prefix) => phoneNumber.startsWith(prefix));
    if (!isTollFree) return [];

    try {
      const phoneSid = await getPhoneNumberSid(accountSid, authToken, phoneNumber);
      if (!phoneSid) {
        return [{
          name: 'toll_free_verification',
          passed: false,
          message: `Phone number ${phoneNumber} not found on Twilio account`,
        }];
      }

      const verification = await getTollFreeVerificationStatus(accountSid, authToken, phoneSid);
      if (!verification) {
        return [{
          name: 'toll_free_verification',
          passed: false,
          message: 'No toll-free verification submitted. Verification is required for SMS sending.',
        }];
      }

      const approved = verification.status === 'TWILIO_APPROVED';
      return [{
        name: 'toll_free_verification',
        passed: approved,
        message: `toll_free_verification: ${verification.status}`,
      }];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return [{
        name: 'toll_free_verification',
        passed: false,
        message: `Failed to check toll-free verification: ${message}`,
      }];
    }
  },
};

// ── Telegram Probe ──────────────────────────────────────────────────────────

const telegramProbe: ChannelProbe = {
  channel: 'telegram',
  runLocalChecks(): ReadinessCheckResult[] {
    const results: ReadinessCheckResult[] = [];

    const hasBotToken = !!getSecureKey('credential:telegram:bot_token');
    results.push({
      name: 'bot_token',
      passed: hasBotToken,
      message: hasBotToken
        ? 'Telegram bot token is configured'
        : 'Telegram bot token is not configured',
    });

    const hasWebhookSecret = !!getSecureKey('credential:telegram:webhook_secret');
    results.push({
      name: 'webhook_secret',
      passed: hasWebhookSecret,
      message: hasWebhookSecret
        ? 'Telegram webhook secret is configured'
        : 'Telegram webhook secret is not configured',
    });

    const hasIngress = hasIngressConfigured();
    results.push({
      name: 'ingress',
      passed: hasIngress,
      message: hasIngress
        ? 'Public ingress URL is configured'
        : 'Public ingress URL is not configured or disabled',
    });

    return results;
  },
  // Telegram has no remote checks currently
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
   * Local checks always run inline. Remote checks run only when `includeRemote`
   * is true and the cache is stale or missing.
   */
  async getReadiness(
    channel?: ChannelId,
    includeRemote?: boolean,
    assistantId?: string,
  ): Promise<ChannelReadinessSnapshot[]> {
    const channels = channel
      ? [channel]
      : Array.from(this.probes.keys());

    const results: ChannelReadinessSnapshot[] = [];
    for (const ch of channels) {
      const probe = this.probes.get(ch);
      if (!probe) {
        results.push(this.unsupportedSnapshot(ch));
        continue;
      }

      const probeContext: ChannelProbeContext = { assistantId };
      const localChecks = probe.runLocalChecks(probeContext);
      let remoteChecks: ReadinessCheckResult[] | undefined;
      let remoteChecksFreshlyFetched = false;
      let remoteChecksAffectReadiness = false;
      let stale = false;

      const cacheKey = this.snapshotCacheKey(ch, assistantId);
      const cached = this.snapshots.get(cacheKey);
      const now = Date.now();

      if (includeRemote && probe.runRemoteChecks) {
        const cacheExpired = !cached || !cached.remoteChecks || (now - cached.checkedAt) >= REMOTE_TTL_MS;
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
        // Surface cached remote checks when present. Stale checks are included
        // for visibility but do not affect readiness until explicitly refreshed.
        remoteChecks = cached.remoteChecks;
        stale = (now - cached.checkedAt) >= REMOTE_TTL_MS;
        remoteChecksAffectReadiness = !stale;
      }

      const allLocalPassed = localChecks.every((c) => c.passed);
      const allRemotePassed = (remoteChecks && remoteChecksAffectReadiness)
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
        checkedAt: (remoteChecks && cached && !remoteChecksFreshlyFetched) ? cached.checkedAt : now,
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
  invalidateChannel(channel: ChannelId, assistantId?: string): void {
    if (assistantId) {
      this.snapshots.delete(this.snapshotCacheKey(channel, assistantId));
      return;
    }
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
      reasons: [{ code: 'unsupported_channel', text: `Channel ${channel} is not supported` }],
      localChecks: [],
    };
  }

  private snapshotCacheKey(channel: ChannelId, assistantId?: string): string {
    return `${channel}::${assistantId ?? '__default__'}`;
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

/** Create a service instance with built-in SMS and Telegram probes registered. */
export function createReadinessService(): ChannelReadinessService {
  const service = new ChannelReadinessService();
  service.registerProbe(smsProbe);
  service.registerProbe(telegramProbe);
  return service;
}
