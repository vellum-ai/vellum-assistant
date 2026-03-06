import type { GatewayConfig } from "./config.js";
import type { CredentialChangeEvent } from "./credential-watcher.js";

type CredentialServiceMapping = {
  /** Key on CredentialChangeEvent indicating whether this service changed. */
  changedKey: keyof CredentialChangeEvent & `${string}Changed`;
  /** Key on CredentialChangeEvent containing the credentials object. */
  credentialsKey: keyof CredentialChangeEvent & `${string}Credentials`;
  /** Whether to skip updates when env vars provide these credentials. */
  envGuarded: boolean;
  /** Maps credential object fields to GatewayConfig fields. */
  fields: Array<{
    credField: string;
    configField: keyof GatewayConfig;
  }>;
};

export function buildCredentialServiceMappings(opts: {
  telegramFromEnv: boolean;
  slackFromEnv: boolean;
}): CredentialServiceMapping[] {
  return [
    {
      changedKey: "telegramChanged",
      credentialsKey: "telegramCredentials",
      envGuarded: opts.telegramFromEnv,
      fields: [
        { credField: "botToken", configField: "telegramBotToken" },
        { credField: "webhookSecret", configField: "telegramWebhookSecret" },
      ],
    },
    {
      changedKey: "twilioChanged",
      credentialsKey: "twilioCredentials",
      envGuarded: false,
      fields: [
        { credField: "accountSid", configField: "twilioAccountSid" },
        { credField: "authToken", configField: "twilioAuthToken" },
      ],
    },
    {
      changedKey: "whatsappChanged",
      credentialsKey: "whatsappCredentials",
      envGuarded: false,
      fields: [
        { credField: "phoneNumberId", configField: "whatsappPhoneNumberId" },
        { credField: "accessToken", configField: "whatsappAccessToken" },
        { credField: "appSecret", configField: "whatsappAppSecret" },
        {
          credField: "webhookVerifyToken",
          configField: "whatsappWebhookVerifyToken",
        },
      ],
    },
    {
      changedKey: "slackChannelChanged",
      credentialsKey: "slackChannelCredentials",
      envGuarded: opts.slackFromEnv,
      fields: [
        { credField: "botToken", configField: "slackChannelBotToken" },
        { credField: "appToken", configField: "slackChannelAppToken" },
      ],
    },
  ];
}

export function applyCredentialChanges(
  event: CredentialChangeEvent,
  config: GatewayConfig,
  mappings: CredentialServiceMapping[],
  log: { info: (msg: string) => void },
): Set<string> {
  const changedServices = new Set<string>();
  for (const mapping of mappings) {
    if (!event[mapping.changedKey]) continue;
    if (mapping.envGuarded) continue;
    const creds = event[mapping.credentialsKey] as Record<
      string,
      unknown
    > | null;
    for (const { credField, configField } of mapping.fields) {
      (config as Record<string, unknown>)[configField] = creds
        ? (creds as Record<string, unknown>)[credField]
        : undefined;
    }
    // Extract a human-friendly service name from the changedKey (e.g. "telegramChanged" -> "Telegram")
    const serviceName = mapping.changedKey.replace("Changed", "");
    const capitalizedName =
      serviceName.charAt(0).toUpperCase() + serviceName.slice(1);
    log.info(
      creds
        ? `${capitalizedName} credentials loaded from credential vault`
        : `${capitalizedName} credentials cleared`,
    );
    changedServices.add(serviceName);
  }
  return changedServices;
}
