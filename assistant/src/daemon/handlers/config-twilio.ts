import * as net from 'node:net';
import { loadRawConfig, saveRawConfig } from '../../config/loader.js';
import { getSecureKey, setSecureKey, deleteSecureKey } from '../../security/secure-keys.js';
import { upsertCredentialMetadata, deleteCredentialMetadata } from '../../tools/credentials/metadata-store.js';
import { readHttpToken } from '../../util/platform.js';
import {
  hasTwilioCredentials,
  listIncomingPhoneNumbers,
  searchAvailableNumbers,
  provisionPhoneNumber,
  releasePhoneNumber,
  fetchMessageStatus,
  getPhoneNumberSid,
  getTollFreeVerificationStatus,
  getTollFreeVerificationBySid,
  submitTollFreeVerification,
  updateTollFreeVerification,
  deleteTollFreeVerification,
  type TollFreeVerificationSubmitParams,
} from '../../calls/twilio-rest.js';
import type { IngressConfig } from '../../inbound/public-ingress-urls.js';
import { syncTwilioWebhooks } from './config-ingress.js';
import { getReadinessService } from './config-channels.js';
import type { TwilioConfigRequest } from '../ipc-protocol.js';
import { log, CONFIG_RELOAD_DEBOUNCE_MS, defineHandlers, type HandlerContext } from './shared.js';
import { getGatewayInternalBaseUrl } from '../../config/env.js';

/** In-memory store for the last SMS send test result. Shared between sms_send_test and sms_doctor. */
let _lastTestResult: {
  messageSid: string;
  to: string;
  initialStatus: string;
  finalStatus: string;
  errorCode?: string;
  errorMessage?: string;
  timestamp: number;
} | undefined;

/** Map a Twilio error code to a human-readable remediation suggestion. */
function mapTwilioErrorRemediation(errorCode: string | undefined): string | undefined {
  if (!errorCode) return undefined;
  const map: Record<string, string> = {
    '30003': 'Unreachable destination. The handset may be off or out of service.',
    '30004': 'Message blocked by carrier or recipient.',
    '30005': 'Unknown destination phone number. Verify the number is valid.',
    '30006': 'Landline or unreachable carrier. SMS cannot be delivered to this number.',
    '30007': 'Message flagged as spam by carrier. Adjust content or register for A2P.',
    '30008': 'Unknown error from the carrier network.',
    '21610': 'Recipient has opted out (STOP). Cannot send until they opt back in.',
  };
  return map[errorCode];
}

const TWILIO_USE_CASE_ALIASES: Record<string, string> = {
  ACCOUNT_NOTIFICATION: 'ACCOUNT_NOTIFICATIONS',
  DELIVERY_NOTIFICATION: 'DELIVERY_NOTIFICATIONS',
  FRAUD_ALERT: 'FRAUD_ALERT_MESSAGING',
  POLLING_AND_VOTING: 'POLLING_AND_VOTING_NON_POLITICAL',
};

const TWILIO_VALID_USE_CASE_CATEGORIES = [
  'TWO_FACTOR_AUTHENTICATION',
  'ACCOUNT_NOTIFICATIONS',
  'CUSTOMER_CARE',
  'CHARITY_NONPROFIT',
  'DELIVERY_NOTIFICATIONS',
  'FRAUD_ALERT_MESSAGING',
  'EVENTS',
  'HIGHER_EDUCATION',
  'K12',
  'MARKETING',
  'POLLING_AND_VOTING_NON_POLITICAL',
  'POLITICAL_ELECTION_CAMPAIGNS',
  'PUBLIC_SERVICE_ANNOUNCEMENT',
  'SECURITY_ALERT',
] as const;

function normalizeUseCaseCategories(rawCategories: string[]): string[] {
  const normalized = rawCategories.map((value) => TWILIO_USE_CASE_ALIASES[value] ?? value);
  return Array.from(new Set(normalized));
}

export async function handleTwilioConfig(
  msg: TwilioConfigRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    if (msg.action === 'get') {
      const hasCredentials = hasTwilioCredentials();
      const raw = loadRawConfig();
      const sms = (raw?.sms ?? {}) as Record<string, unknown>;
      // When assistantId is provided, look up in assistantPhoneNumbers first,
      // fall back to the legacy phoneNumber field
      let phoneNumber: string;
      if (msg.assistantId) {
        const mapping = (sms.assistantPhoneNumbers as Record<string, string> | undefined) ?? {};
        phoneNumber = mapping[msg.assistantId] ?? (sms.phoneNumber as string) ?? '';
      } else {
        phoneNumber = (sms.phoneNumber as string) ?? '';
      }
      ctx.send(socket, {
        type: 'twilio_config_response',
        success: true,
        hasCredentials,
        phoneNumber: phoneNumber || undefined,
      });
    } else if (msg.action === 'set_credentials') {
      if (!msg.accountSid || !msg.authToken) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: hasTwilioCredentials(),
          error: 'accountSid and authToken are required for set_credentials action',
        });
        return;
      }

      // Validate credentials by calling the Twilio API
      const authHeader = 'Basic ' + Buffer.from(`${msg.accountSid}:${msg.authToken}`).toString('base64');
      try {
        const res = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${msg.accountSid}.json`,
          {
            method: 'GET',
            headers: { Authorization: authHeader },
          },
        );
        if (!res.ok) {
          const body = await res.text();
          ctx.send(socket, {
            type: 'twilio_config_response',
            success: false,
            hasCredentials: hasTwilioCredentials(),
            error: `Twilio API validation failed (${res.status}): ${body}`,
          });
          return;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: hasTwilioCredentials(),
          error: `Failed to validate Twilio credentials: ${message}`,
        });
        return;
      }

      // Store credentials securely
      const sidStored = setSecureKey('credential:twilio:account_sid', msg.accountSid);
      if (!sidStored) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: false,
          error: 'Failed to store Account SID in secure storage',
        });
        return;
      }

      const tokenStored = setSecureKey('credential:twilio:auth_token', msg.authToken);
      if (!tokenStored) {
        // Roll back the Account SID
        deleteSecureKey('credential:twilio:account_sid');
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: false,
          error: 'Failed to store Auth Token in secure storage',
        });
        return;
      }

      upsertCredentialMetadata('twilio', 'account_sid', {});
      upsertCredentialMetadata('twilio', 'auth_token', {});

      ctx.send(socket, {
        type: 'twilio_config_response',
        success: true,
        hasCredentials: true,
      });
    } else if (msg.action === 'clear_credentials') {
      // Only clear authentication credentials (Account SID and Auth Token).
      // Preserve the phone number in both config (sms.phoneNumber) and secure
      // key (credential:twilio:phone_number) so that re-entering credentials
      // resumes working without needing to reassign the number.
      deleteSecureKey('credential:twilio:account_sid');
      deleteSecureKey('credential:twilio:auth_token');
      deleteCredentialMetadata('twilio', 'account_sid');
      deleteCredentialMetadata('twilio', 'auth_token');

      ctx.send(socket, {
        type: 'twilio_config_response',
        success: true,
        hasCredentials: false,
      });
    } else if (msg.action === 'provision_number') {
      if (!hasTwilioCredentials()) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: false,
          error: 'Twilio credentials not configured. Set credentials first.',
        });
        return;
      }

      const accountSid = getSecureKey('credential:twilio:account_sid')!;
      const authToken = getSecureKey('credential:twilio:auth_token')!;
      const country = msg.country ?? 'US';

      // Search for an available number
      const available = await searchAvailableNumbers(accountSid, authToken, country, msg.areaCode);
      if (available.length === 0) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: true,
          error: `No available phone numbers found for country=${country}${msg.areaCode ? ` areaCode=${msg.areaCode}` : ''}`,
        });
        return;
      }

      // Purchase the first available number
      const purchased = await provisionPhoneNumber(accountSid, authToken, available[0].phoneNumber);

      // Auto-assign: persist the purchased number in secure storage and config
      // (same persistence as assign_number for consistency)
      const phoneStored = setSecureKey('credential:twilio:phone_number', purchased.phoneNumber);
      if (!phoneStored) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: hasTwilioCredentials(),
          phoneNumber: purchased.phoneNumber,
          error: `Phone number ${purchased.phoneNumber} was purchased but could not be saved. Use assign_number to assign it manually.`,
        });
        return;
      }

      const raw = loadRawConfig();
      const sms = (raw?.sms ?? {}) as Record<string, unknown>;
      // When assistantId is provided, only set the legacy global phoneNumber
      // if it's not already set — this prevents multi-assistant assignments
      // from clobbering each other's outbound SMS number.
      if (msg.assistantId) {
        if (!sms.phoneNumber) {
          sms.phoneNumber = purchased.phoneNumber;
        }
      } else {
        sms.phoneNumber = purchased.phoneNumber;
      }
      // When assistantId is provided, also persist into the per-assistant mapping
      if (msg.assistantId) {
        const mapping = (sms.assistantPhoneNumbers as Record<string, string> | undefined) ?? {};
        mapping[msg.assistantId] = purchased.phoneNumber;
        sms.assistantPhoneNumbers = mapping;
      }

      const wasSuppressed = ctx.suppressConfigReload;
      ctx.setSuppressConfigReload(true);
      try {
        saveRawConfig({ ...raw, sms });
      } catch (err) {
        ctx.setSuppressConfigReload(wasSuppressed);
        throw err;
      }
      ctx.debounceTimers.schedule('__suppress_reset__', () => { ctx.setSuppressConfigReload(false); }, CONFIG_RELOAD_DEBOUNCE_MS);

      // Best-effort webhook configuration — non-fatal so the number is
      // still usable even if ingress isn't configured yet.
      const webhookResult = await syncTwilioWebhooks(
        purchased.phoneNumber,
        accountSid,
        authToken,
        loadRawConfig() as IngressConfig,
      );

      ctx.send(socket, {
        type: 'twilio_config_response',
        success: true,
        hasCredentials: true,
        phoneNumber: purchased.phoneNumber,
        warning: webhookResult.warning,
      });
    } else if (msg.action === 'assign_number') {
      if (!msg.phoneNumber) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: hasTwilioCredentials(),
          error: 'phoneNumber is required for assign_number action',
        });
        return;
      }

      // Persist the phone number in the secure credential store so the
      // active Twilio runtime can read it via credential:twilio:phone_number
      const phoneStored = setSecureKey('credential:twilio:phone_number', msg.phoneNumber);
      if (!phoneStored) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: hasTwilioCredentials(),
          error: 'Failed to store phone number in secure storage',
        });
        return;
      }

      // Also persist in assistant config (non-secret) for the UI
      const raw = loadRawConfig();
      const sms = (raw?.sms ?? {}) as Record<string, unknown>;
      // When assistantId is provided, only set the legacy global phoneNumber
      // if it's not already set — this prevents multi-assistant assignments
      // from clobbering each other's outbound SMS number.
      if (msg.assistantId) {
        if (!sms.phoneNumber) {
          sms.phoneNumber = msg.phoneNumber;
        }
      } else {
        sms.phoneNumber = msg.phoneNumber;
      }
      // When assistantId is provided, also persist into the per-assistant mapping
      if (msg.assistantId) {
        const mapping = (sms.assistantPhoneNumbers as Record<string, string> | undefined) ?? {};
        mapping[msg.assistantId] = msg.phoneNumber;
        sms.assistantPhoneNumbers = mapping;
      }

      const wasSuppressed = ctx.suppressConfigReload;
      ctx.setSuppressConfigReload(true);
      try {
        saveRawConfig({ ...raw, sms });
      } catch (err) {
        ctx.setSuppressConfigReload(wasSuppressed);
        throw err;
      }
      ctx.debounceTimers.schedule('__suppress_reset__', () => { ctx.setSuppressConfigReload(false); }, CONFIG_RELOAD_DEBOUNCE_MS);

      // Best-effort webhook configuration when credentials are available
      let webhookWarning: string | undefined;
      if (hasTwilioCredentials()) {
        const acctSid = getSecureKey('credential:twilio:account_sid')!;
        const acctToken = getSecureKey('credential:twilio:auth_token')!;
        const webhookResult = await syncTwilioWebhooks(
          msg.phoneNumber,
          acctSid,
          acctToken,
          loadRawConfig() as IngressConfig,
        );
        webhookWarning = webhookResult.warning;
      }

      ctx.send(socket, {
        type: 'twilio_config_response',
        success: true,
        hasCredentials: hasTwilioCredentials(),
        phoneNumber: msg.phoneNumber,
        warning: webhookWarning,
      });
    } else if (msg.action === 'list_numbers') {
      if (!hasTwilioCredentials()) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: false,
          error: 'Twilio credentials not configured. Set credentials first.',
        });
        return;
      }

      const accountSid = getSecureKey('credential:twilio:account_sid')!;
      const authToken = getSecureKey('credential:twilio:auth_token')!;
      const numbers = await listIncomingPhoneNumbers(accountSid, authToken);

      ctx.send(socket, {
        type: 'twilio_config_response',
        success: true,
        hasCredentials: true,
        numbers,
      });
    } else if (msg.action === 'sms_compliance_status') {
      if (!hasTwilioCredentials()) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: false,
          error: 'Twilio credentials not configured. Set credentials first.',
        });
        return;
      }

      const raw = loadRawConfig();
      const sms = (raw?.sms ?? {}) as Record<string, unknown>;
      let phoneNumber: string;
      if (msg.assistantId) {
        const mapping = (sms.assistantPhoneNumbers as Record<string, string> | undefined) ?? {};
        phoneNumber = mapping[msg.assistantId] ?? (sms.phoneNumber as string) ?? '';
      } else {
        phoneNumber = (sms.phoneNumber as string) ?? '';
      }

      if (!phoneNumber) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: true,
          error: 'No phone number assigned. Assign a number first.',
        });
        return;
      }

      const accountSid = getSecureKey('credential:twilio:account_sid')!;
      const authToken = getSecureKey('credential:twilio:auth_token')!;

      // Determine number type from prefix
      const tollFreePrefixes = ['+1800', '+1833', '+1844', '+1855', '+1866', '+1877', '+1888'];
      const isTollFree = tollFreePrefixes.some((prefix) => phoneNumber.startsWith(prefix));
      const numberType = isTollFree ? 'toll_free' : 'local_10dlc';

      if (!isTollFree) {
        // Non-toll-free numbers don't need toll-free verification
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: true,
          hasCredentials: true,
          phoneNumber,
          compliance: { numberType },
        });
        return;
      }

      // Look up the phone number SID and check verification status
      const phoneSid = await getPhoneNumberSid(accountSid, authToken, phoneNumber);
      if (!phoneSid) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: true,
          phoneNumber,
          error: `Phone number ${phoneNumber} not found on Twilio account`,
        });
        return;
      }

      const verification = await getTollFreeVerificationStatus(accountSid, authToken, phoneSid);

      ctx.send(socket, {
        type: 'twilio_config_response',
        success: true,
        hasCredentials: true,
        phoneNumber,
        compliance: {
          numberType,
          verificationSid: verification?.sid,
          verificationStatus: verification?.status,
          rejectionReason: verification?.rejectionReason,
          rejectionReasons: verification?.rejectionReasons,
          errorCode: verification?.errorCode,
          editAllowed: verification?.editAllowed,
          editExpiration: verification?.editExpiration,
        },
      });
    } else if (msg.action === 'sms_submit_tollfree_verification') {
      if (!hasTwilioCredentials()) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: false,
          error: 'Twilio credentials not configured. Set credentials first.',
        });
        return;
      }

      const vp = msg.verificationParams;
      if (!vp) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: true,
          error: 'verificationParams is required for sms_submit_tollfree_verification action',
        });
        return;
      }

      // Validate required fields
      const requiredFields: Array<[string, unknown]> = [
        ['tollfreePhoneNumberSid', vp.tollfreePhoneNumberSid],
        ['businessName', vp.businessName],
        ['businessWebsite', vp.businessWebsite],
        ['notificationEmail', vp.notificationEmail],
        ['useCaseCategories', vp.useCaseCategories],
        ['useCaseSummary', vp.useCaseSummary],
        ['productionMessageSample', vp.productionMessageSample],
        ['optInImageUrls', vp.optInImageUrls],
        ['optInType', vp.optInType],
        ['messageVolume', vp.messageVolume],
      ];

      const missing = requiredFields
        .filter(([, v]) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0))
        .map(([name]) => name);

      if (missing.length > 0) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: true,
          error: `Missing required verification fields: ${missing.join(', ')}`,
        });
        return;
      }

      // Validate enum values
      const normalizedUseCaseCategories = normalizeUseCaseCategories(vp.useCaseCategories ?? []);
      const invalidCategories = normalizedUseCaseCategories.filter(
        (c) => !TWILIO_VALID_USE_CASE_CATEGORIES.includes(c as (typeof TWILIO_VALID_USE_CASE_CATEGORIES)[number]),
      );
      if (invalidCategories.length > 0) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: true,
          error: `Invalid useCaseCategories: ${invalidCategories.join(', ')}. Valid values: ${TWILIO_VALID_USE_CASE_CATEGORIES.join(', ')}`,
        });
        return;
      }

      const validOptInTypes = ['VERBAL', 'WEB_FORM', 'PAPER_FORM', 'VIA_TEXT', 'MOBILE_QR_CODE'];
      if (!validOptInTypes.includes(vp.optInType!)) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: true,
          error: `Invalid optInType: ${vp.optInType}. Valid values: ${validOptInTypes.join(', ')}`,
        });
        return;
      }

      const validMessageVolumes = [
        '10', '100', '1,000', '10,000', '100,000', '250,000',
        '500,000', '750,000', '1,000,000', '5,000,000', '10,000,000+',
      ];
      if (!validMessageVolumes.includes(vp.messageVolume!)) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: true,
          error: `Invalid messageVolume: ${vp.messageVolume}. Valid values: ${validMessageVolumes.join(', ')}`,
        });
        return;
      }

      const accountSid = getSecureKey('credential:twilio:account_sid')!;
      const authToken = getSecureKey('credential:twilio:auth_token')!;

      const submitParams: TollFreeVerificationSubmitParams = {
        tollfreePhoneNumberSid: vp.tollfreePhoneNumberSid!,
        businessName: vp.businessName!,
        businessWebsite: vp.businessWebsite!,
        notificationEmail: vp.notificationEmail!,
        useCaseCategories: normalizedUseCaseCategories,
        useCaseSummary: vp.useCaseSummary!,
        productionMessageSample: vp.productionMessageSample!,
        optInImageUrls: vp.optInImageUrls!,
        optInType: vp.optInType!,
        messageVolume: vp.messageVolume!,
        businessType: vp.businessType ?? 'SOLE_PROPRIETOR',
        customerProfileSid: vp.customerProfileSid,
      };

      const verification = await submitTollFreeVerification(accountSid, authToken, submitParams);

      ctx.send(socket, {
        type: 'twilio_config_response',
        success: true,
        hasCredentials: true,
        compliance: {
          numberType: 'toll_free',
          verificationSid: verification.sid,
          verificationStatus: verification.status,
        },
      });
    } else if (msg.action === 'sms_update_tollfree_verification') {
      if (!hasTwilioCredentials()) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: false,
          error: 'Twilio credentials not configured. Set credentials first.',
        });
        return;
      }

      if (!msg.verificationSid) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: true,
          error: 'verificationSid is required for sms_update_tollfree_verification action',
        });
        return;
      }

      const accountSid = getSecureKey('credential:twilio:account_sid')!;
      const authToken = getSecureKey('credential:twilio:auth_token')!;

      const currentVerification = await getTollFreeVerificationBySid(accountSid, authToken, msg.verificationSid);
      if (!currentVerification) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: true,
          error: `Verification ${msg.verificationSid} was not found on this Twilio account.`,
        });
        return;
      }

      if (currentVerification.status === 'TWILIO_REJECTED') {
        const expirationMillis = currentVerification.editExpiration
          ? Date.parse(currentVerification.editExpiration)
          : Number.NaN;
        const editExpired = Number.isFinite(expirationMillis) && Date.now() > expirationMillis;
        if (currentVerification.editAllowed === false || editExpired) {
          const detail = editExpired
            ? `edit_expiration=${currentVerification.editExpiration}`
            : 'edit_allowed=false';
          ctx.send(socket, {
            type: 'twilio_config_response',
            success: false,
            hasCredentials: true,
            error: `Verification ${msg.verificationSid} cannot be updated (${detail}). Delete and resubmit instead.`,
            compliance: {
              numberType: 'toll_free',
              verificationSid: currentVerification.sid,
              verificationStatus: currentVerification.status,
              editAllowed: currentVerification.editAllowed,
              editExpiration: currentVerification.editExpiration,
            },
          });
          return;
        }
      }

      const updateParams = { ...(msg.verificationParams ?? {}) };
      if (updateParams.useCaseCategories) {
        updateParams.useCaseCategories = normalizeUseCaseCategories(updateParams.useCaseCategories);
      }

      const verification = await updateTollFreeVerification(
        accountSid,
        authToken,
        msg.verificationSid,
        updateParams,
      );

      ctx.send(socket, {
        type: 'twilio_config_response',
        success: true,
        hasCredentials: true,
        compliance: {
          numberType: 'toll_free',
          verificationSid: verification.sid,
          verificationStatus: verification.status,
          editAllowed: verification.editAllowed,
          editExpiration: verification.editExpiration,
        },
      });
    } else if (msg.action === 'sms_delete_tollfree_verification') {
      if (!hasTwilioCredentials()) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: false,
          error: 'Twilio credentials not configured. Set credentials first.',
        });
        return;
      }

      if (!msg.verificationSid) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: true,
          error: 'verificationSid is required for sms_delete_tollfree_verification action',
        });
        return;
      }

      const accountSid = getSecureKey('credential:twilio:account_sid')!;
      const authToken = getSecureKey('credential:twilio:auth_token')!;

      await deleteTollFreeVerification(accountSid, authToken, msg.verificationSid);

      ctx.send(socket, {
        type: 'twilio_config_response',
        success: true,
        hasCredentials: true,
        warning: 'Toll-free verification deleted. Re-submitting may reset your position in the review queue.',
      });
    } else if (msg.action === 'release_number') {
      if (!hasTwilioCredentials()) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: false,
          error: 'Twilio credentials not configured. Set credentials first.',
        });
        return;
      }

      const raw = loadRawConfig();
      const sms = (raw?.sms ?? {}) as Record<string, unknown>;
      let phoneNumber: string;
      if (msg.phoneNumber) {
        phoneNumber = msg.phoneNumber;
      } else if (msg.assistantId) {
        const mapping = (sms.assistantPhoneNumbers as Record<string, string> | undefined) ?? {};
        phoneNumber = mapping[msg.assistantId] ?? (sms.phoneNumber as string) ?? '';
      } else {
        phoneNumber = (sms.phoneNumber as string) ?? '';
      }

      if (!phoneNumber) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: true,
          error: 'No phone number to release. Specify phoneNumber or ensure one is assigned.',
        });
        return;
      }

      const accountSid = getSecureKey('credential:twilio:account_sid')!;
      const authToken = getSecureKey('credential:twilio:auth_token')!;

      await releasePhoneNumber(accountSid, authToken, phoneNumber);

      // Clear the number from config and secure key store
      if (sms.phoneNumber === phoneNumber) {
        delete sms.phoneNumber;
      }
      const assistantPhoneNumbers = sms.assistantPhoneNumbers as Record<string, string> | undefined;
      if (assistantPhoneNumbers) {
        for (const [id, num] of Object.entries(assistantPhoneNumbers)) {
          if (num === phoneNumber) {
            delete assistantPhoneNumbers[id];
          }
        }
        if (Object.keys(assistantPhoneNumbers).length === 0) {
          delete sms.assistantPhoneNumbers;
        }
      }

      const wasSuppressed = ctx.suppressConfigReload;
      ctx.setSuppressConfigReload(true);
      try {
        saveRawConfig({ ...raw, sms });
      } catch (err) {
        ctx.setSuppressConfigReload(wasSuppressed);
        throw err;
      }
      ctx.debounceTimers.schedule('__suppress_reset__', () => { ctx.setSuppressConfigReload(false); }, CONFIG_RELOAD_DEBOUNCE_MS);

      // Clear the phone number from secure key store if it matches
      const storedPhone = getSecureKey('credential:twilio:phone_number');
      if (storedPhone === phoneNumber) {
        deleteSecureKey('credential:twilio:phone_number');
      }

      ctx.send(socket, {
        type: 'twilio_config_response',
        success: true,
        hasCredentials: true,
        warning: 'Phone number released from Twilio. Any associated toll-free verification context is lost.',
      });
    } else if (msg.action === 'sms_send_test') {
      // ── SMS send test ────────────────────────────────────────────────
      if (!hasTwilioCredentials()) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: false,
          error: 'Twilio credentials not configured. Set credentials first.',
        });
        return;
      }

      const to = msg.phoneNumber;
      if (!to) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: true,
          error: 'phoneNumber is required for sms_send_test action.',
        });
        return;
      }

      const raw = loadRawConfig();
      const smsSection = (raw?.sms ?? {}) as Record<string, unknown>;
      let from = '';
      // When assistantId is provided, check assistant-scoped phone mapping first
      if (msg.assistantId) {
        const mapping = (smsSection.assistantPhoneNumbers as Record<string, string> | undefined) ?? {};
        from = mapping[msg.assistantId] ?? '';
      }
      // Fall back to global phone number
      if (!from) {
        from = (smsSection.phoneNumber as string | undefined)
          || getSecureKey('credential:twilio:phone_number')
          || '';
      }
      if (!from) {
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: true,
          error: 'No phone number assigned. Run the twilio-setup skill to assign a number.',
        });
        return;
      }

      const accountSid = getSecureKey('credential:twilio:account_sid')!;
      const authToken = getSecureKey('credential:twilio:auth_token')!;
      const text = msg.text || 'Test SMS from your Vellum assistant';

      // Send via gateway's /deliver/sms endpoint
      const bearerToken = readHttpToken();
      const gatewayUrl = getGatewayInternalBaseUrl();

      const sendResp = await fetch(`${gatewayUrl}/deliver/sms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
        },
        body: JSON.stringify({ to, text, ...(msg.assistantId ? { assistantId: msg.assistantId } : {}) }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!sendResp.ok) {
        const errBody = await sendResp.text().catch(() => '<unreadable>');
        ctx.send(socket, {
          type: 'twilio_config_response',
          success: false,
          hasCredentials: true,
          error: `SMS send failed (${sendResp.status}): ${errBody}`,
        });
        return;
      }

      const sendData = await sendResp.json().catch(() => ({})) as {
        messageSid?: string;
        status?: string;
      };
      const messageSid = sendData.messageSid || '';
      const initialStatus = sendData.status || 'unknown';

      // Poll Twilio for final status (up to 3 times, 2s apart)
      let finalStatus = initialStatus;
      let errorCode: string | undefined;
      let errorMessage: string | undefined;

      if (messageSid) {
        for (let i = 0; i < 3; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          try {
            const pollResult = await fetchMessageStatus(accountSid, authToken, messageSid);
            finalStatus = pollResult.status;
            errorCode = pollResult.errorCode;
            errorMessage = pollResult.errorMessage;
            // Stop polling if we've reached a terminal status
            if (['delivered', 'undelivered', 'failed'].includes(finalStatus)) break;
          } catch {
            // Polling failure is non-fatal; we'll use the last known status
            break;
          }
        }
      }

      const testResult = {
        messageSid,
        to,
        initialStatus,
        finalStatus,
        ...(errorCode ? { errorCode } : {}),
        ...(errorMessage ? { errorMessage } : {}),
      };

      // Store for sms_doctor
      _lastTestResult = { ...testResult, timestamp: Date.now() };

      ctx.send(socket, {
        type: 'twilio_config_response',
        success: true,
        hasCredentials: true,
        testResult,
      });

    } else if (msg.action === 'sms_doctor') {
      // ── SMS doctor diagnostic ────────────────────────────────────────
      const hasCredentials = hasTwilioCredentials();

      // 1. Channel readiness check
      let readinessReady = false;
      const readinessIssues: string[] = [];
      try {
        const readinessService = getReadinessService();
        const snapshots = await readinessService.getReadiness('sms', false, msg.assistantId);
        const snapshot = snapshots[0];
        if (snapshot) {
          readinessReady = snapshot.ready;
          for (const r of snapshot.reasons) {
            readinessIssues.push(r.text);
          }
        } else {
          readinessIssues.push('No readiness snapshot returned for SMS channel');
        }
      } catch (err) {
        readinessIssues.push(`Readiness check failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // 2. Compliance status
      let complianceStatus = 'unknown';
      let complianceDetail: string | undefined;
      let complianceRemediation: string | undefined;
      if (hasCredentials) {
        try {
          const raw = loadRawConfig();
          const smsSection = (raw?.sms ?? {}) as Record<string, unknown>;
          let phoneNumber = '';
          if (msg.assistantId) {
            const mapping = (smsSection.assistantPhoneNumbers as Record<string, string> | undefined) ?? {};
            phoneNumber = mapping[msg.assistantId] ?? '';
          }
          if (!phoneNumber) {
            phoneNumber = (smsSection.phoneNumber as string | undefined) || getSecureKey('credential:twilio:phone_number') || '';
          }
          if (phoneNumber) {
            const accountSid = getSecureKey('credential:twilio:account_sid')!;
            const authToken = getSecureKey('credential:twilio:auth_token')!;
            // Determine number type and verification status
            const isTollFree = phoneNumber.startsWith('+1') && ['800','888','877','866','855','844','833'].some(
              (p) => phoneNumber.startsWith(`+1${p}`),
            );
            if (isTollFree) {
              try {
                const phoneSid = await getPhoneNumberSid(accountSid, authToken, phoneNumber);
                if (!phoneSid) {
                  complianceStatus = 'check_failed';
                  complianceDetail = `Assigned number ${phoneNumber} was not found on the Twilio account`;
                  complianceRemediation = 'Reassign the number in twilio-setup or update credentials to the matching account.';
                } else {
                  const verification = await getTollFreeVerificationStatus(accountSid, authToken, phoneSid);
                  if (verification) {
                    const status = verification.status;
                    complianceStatus = status;
                    complianceDetail = `Toll-free verification: ${status}`;
                    if (status === 'TWILIO_APPROVED') {
                      complianceRemediation = undefined;
                    } else if (status === 'PENDING_REVIEW' || status === 'IN_REVIEW') {
                      complianceRemediation = 'Toll-free verification is pending. Messaging may have limited throughput until approved.';
                    } else if (status === 'TWILIO_REJECTED') {
                      if (verification.editAllowed) {
                        complianceRemediation = verification.editExpiration
                          ? `Toll-free verification was rejected but can still be edited until ${verification.editExpiration}. Update and resubmit it.`
                          : 'Toll-free verification was rejected but can still be edited. Update and resubmit it.';
                      } else {
                        complianceRemediation = 'Toll-free verification was rejected and is no longer editable. Delete and resubmit it.';
                      }
                    } else {
                      complianceRemediation = 'Submit a toll-free verification to enable full messaging throughput.';
                    }
                  } else {
                    complianceStatus = 'unverified';
                    complianceDetail = 'Toll-free number without verification';
                    complianceRemediation = 'Submit a toll-free verification request to avoid filtering.';
                  }
                }
              } catch {
                complianceStatus = 'check_failed';
                complianceDetail = 'Could not retrieve toll-free verification status';
              }
            } else {
              complianceStatus = 'local_10dlc';
              complianceDetail = 'Local/10DLC number — carrier registration handled externally';
            }
          } else {
            complianceStatus = 'no_number';
            complianceDetail = 'No phone number assigned';
            complianceRemediation = 'Assign a phone number via the twilio-setup skill.';
          }
        } catch {
          complianceStatus = 'check_failed';
          complianceDetail = 'Could not determine compliance status';
        }
      } else {
        complianceStatus = 'no_credentials';
        complianceDetail = 'Twilio credentials are not configured';
        complianceRemediation = 'Set Twilio credentials via the twilio-setup skill.';
      }

      // 3. Last send test result
      let lastSend: { status: string; errorCode?: string; remediation?: string } | undefined;
      if (_lastTestResult) {
        lastSend = {
          status: _lastTestResult.finalStatus,
          ...((_lastTestResult.errorCode) ? { errorCode: _lastTestResult.errorCode } : {}),
          ...((_lastTestResult.errorCode) ? { remediation: mapTwilioErrorRemediation(_lastTestResult.errorCode) } : {}),
        };
      }

      // 4. Determine overall status
      const actionItems: string[] = [];
      let overallStatus: 'healthy' | 'degraded' | 'broken' = 'healthy';

      if (!hasCredentials) {
        overallStatus = 'broken';
        actionItems.push('Configure Twilio credentials.');
      }
      if (!readinessReady) {
        overallStatus = 'broken';
        for (const issue of readinessIssues) actionItems.push(issue);
      }
      if (complianceStatus === 'unverified' || complianceStatus === 'PENDING_REVIEW' || complianceStatus === 'IN_REVIEW') {
        if (overallStatus === 'healthy') overallStatus = 'degraded';
        if (complianceRemediation) actionItems.push(complianceRemediation);
      }
      if (complianceStatus === 'TWILIO_REJECTED' || complianceStatus === 'no_number') {
        overallStatus = 'broken';
        if (complianceRemediation) actionItems.push(complianceRemediation);
      }
      if (_lastTestResult && ['failed', 'undelivered'].includes(_lastTestResult.finalStatus)) {
        if (overallStatus === 'healthy') overallStatus = 'degraded';
        const remediation = mapTwilioErrorRemediation(_lastTestResult.errorCode);
        actionItems.push(remediation || `Last test SMS ${_lastTestResult.finalStatus}. Check Twilio logs for details.`);
      }

      ctx.send(socket, {
        type: 'twilio_config_response',
        success: true,
        hasCredentials,
        diagnostics: {
          readiness: { ready: readinessReady, issues: readinessIssues },
          compliance: {
            status: complianceStatus,
            ...(complianceDetail ? { detail: complianceDetail } : {}),
            ...(complianceRemediation ? { remediation: complianceRemediation } : {}),
          },
          ...(lastSend ? { lastSend } : {}),
          overallStatus,
          actionItems,
        },
      });

    } else {
      ctx.send(socket, {
        type: 'twilio_config_response',
        success: false,
        hasCredentials: hasTwilioCredentials(),
        error: `Unknown action: ${String((msg as unknown as Record<string, unknown>).action)}`,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Failed to handle Twilio config');
    ctx.send(socket, {
      type: 'twilio_config_response',
      success: false,
      hasCredentials: hasTwilioCredentials(),
      error: message,
    });
  }
}

export const twilioHandlers = defineHandlers({
  twilio_config: handleTwilioConfig,
});
