/**
 * Persistence for credentials collected through a secure prompt.
 *
 * A prompted credential can be delivered in three shapes:
 *   - one-time send: injected into the broker for the next operation, never
 *     written to the vault;
 *   - a Slack channel token: routed through the Slack channel config so the
 *     channel actually connects, not just stored;
 *   - any other credential: written to secure storage.
 *
 * The CLI `credentials prompt` route uses this logic to persist a credential
 * collected through a secure prompt.
 */

import { getConfig } from "../config/loader.js";
import {
  setSlackChannelConfig,
  type SlackChannelConfigResult,
} from "../daemon/handlers/config-slack-channel.js";
import { syncManualTokenConnection } from "../oauth/manual-token-connection.js";
import type { SecretDelivery } from "../permissions/secret-prompt-types.js";
import { credentialKey } from "../security/credential-key.js";
import { setSecureKeyAsync } from "../security/secure-keys.js";
import { credentialBroker } from "../tools/credentials/broker.js";
import {
  getCredentialMetadata,
  upsertCredentialMetadata,
} from "../tools/credentials/metadata-store.js";
import type { CredentialInjectionTemplate } from "../tools/credentials/policy-types.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("prompted-credential");

/** Slack channel credentials connect the channel rather than just storing a value. */
export function isSlackChannelCredential(
  service: string,
  field: string,
): field is "bot_token" | "app_token" | "user_token" {
  return (
    service === "slack_channel" &&
    (field === "bot_token" || field === "app_token" || field === "user_token")
  );
}

export async function storeSlackChannelCredential(
  field: "bot_token" | "app_token" | "user_token",
  value: string,
): Promise<SlackChannelConfigResult> {
  if (field === "bot_token") {
    return setSlackChannelConfig(value, undefined);
  }
  if (field === "app_token") {
    return setSlackChannelConfig(undefined, value);
  }
  return setSlackChannelConfig(undefined, undefined, value);
}

export function formatSlackChannelStatus(
  result: SlackChannelConfigResult,
): string {
  if (result.connected) {
    const teamLabel = result.teamName ?? "Slack";
    const botLabel = result.botUsername ? ` (@${result.botUsername})` : "";
    return ` Slack channel connected to ${teamLabel}${botLabel}.`;
  }
  if (result.warning) {
    return ` ${result.warning}`;
  }
  return "";
}

/**
 * Usage policy carried alongside a prompted credential.
 *
 * `allowedTools` / `allowedDomains` are forwarded to the metadata store as-is:
 * `undefined` leaves an existing credential's list untouched and defaults to
 * deny-all (empty) when creating a new credential, while an explicit empty
 * array sets a deny-all policy. This matches the store's partial-update
 * contract, so re-prompting a credential without policy flags preserves the
 * policy it was originally stored with.
 */
interface PromptedCredentialPolicy {
  allowedTools?: string[];
  allowedDomains?: string[];
  usageDescription?: string;
  injectionTemplates?: CredentialInjectionTemplate[];
}

/**
 * Outcome of persisting a prompted credential.
 *
 * `error` carries a human-readable message (without an "Error:" prefix);
 * `stored` carries the Slack connection result when the value was a Slack
 * channel token.
 */
type PersistPromptedCredentialResult =
  | { outcome: "transient" }
  | { outcome: "stored"; slackChannel?: SlackChannelConfigResult }
  | { outcome: "error"; message: string };

/**
 * Persist a credential value obtained from a secure prompt.
 *
 * The caller is responsible for issuing the prompt and handling a missing
 * value (cancellation / unsupported channel); this function owns everything
 * that happens once a value is in hand.
 */
export async function persistPromptedCredential(args: {
  service: string;
  field: string;
  value: string;
  delivery: SecretDelivery;
  policy: PromptedCredentialPolicy;
}): Promise<PersistPromptedCredentialResult> {
  const { service, field, value, delivery, policy } = args;

  if (delivery === "transient_send") {
    if (isSlackChannelCredential(service, field)) {
      return {
        outcome: "error",
        message:
          "Slack channel credentials must be saved to secure storage. Re-run the secure prompt and choose to store the token.",
      };
    }
    const config = getConfig();
    if (!config.secretDetection.allowOneTimeSend) {
      log.warn(
        { service, field },
        "One-time send requested but not enabled in config",
      );
      return {
        outcome: "error",
        message:
          "one-time send is not enabled. Set secretDetection.allowOneTimeSend to true in config.",
      };
    }
    // Ensure metadata exists so broker policy checks work, but don't overwrite
    // an existing record - a stored credential's policy must not be silently
    // replaced by the transient prompt's policy. Metadata is written before the
    // transient value so no dangling value can fail policy checks.
    if (!getCredentialMetadata(service, field)) {
      try {
        upsertCredentialMetadata(service, field, {
          allowedTools: policy.allowedTools,
          allowedDomains: policy.allowedDomains,
          usageDescription: policy.usageDescription,
          injectionTemplates: policy.injectionTemplates,
        });
      } catch (err) {
        log.error(
          { service, field, err },
          "metadata write failed for transient credential",
        );
        return {
          outcome: "error",
          message: `failed to write credential metadata for ${service}/${field}; the one-time value was discarded.`,
        };
      }
    }
    credentialBroker.injectTransient(service, field, value);
    log.info(
      { service, field, delivery: "transient_send" },
      "One-time secret delivery used",
    );
    return { outcome: "transient" };
  }

  let slackChannel: SlackChannelConfigResult | undefined;
  if (isSlackChannelCredential(service, field)) {
    slackChannel = await storeSlackChannelCredential(field, value);
    if (!slackChannel.success) {
      return {
        outcome: "error",
        message: slackChannel.error ?? "failed to configure Slack channel",
      };
    }
  } else {
    const key = credentialKey(service, field);
    const ok = await setSecureKeyAsync(key, value);
    if (!ok) {
      return { outcome: "error", message: "failed to store credential" };
    }
  }

  try {
    upsertCredentialMetadata(service, field, {
      allowedTools: policy.allowedTools,
      allowedDomains: policy.allowedDomains,
      usageDescription: policy.usageDescription,
      injectionTemplates: policy.injectionTemplates,
    });
  } catch (err) {
    log.warn(
      { service, field, err },
      "metadata write failed after storing credential",
    );
  }

  if (!isSlackChannelCredential(service, field)) {
    await syncManualTokenConnection(service);
  }

  return { outcome: "stored", slackChannel };
}
