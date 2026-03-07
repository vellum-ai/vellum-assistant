import type { CredentialChangeEvent } from "./credential-watcher.js";

type CredentialServiceMapping = {
  /** Key on CredentialChangeEvent indicating whether this service changed. */
  changedKey: keyof CredentialChangeEvent & `${string}Changed`;
  /** Human-friendly name used in log messages (e.g. "Slack channel"). Falls back to capitalizing changedKey. */
  displayName?: string;
};

export function buildCredentialServiceMappings(): CredentialServiceMapping[] {
  return [
    { changedKey: "telegramChanged" },
    { changedKey: "twilioChanged" },
    { changedKey: "whatsappChanged" },
    { changedKey: "slackChannelChanged", displayName: "Slack channel" },
  ];
}

/**
 * Determine which services had credential changes and log them.
 * Returns the set of service names that changed so callers can
 * trigger side effects (e.g. Telegram webhook reconciliation,
 * Slack socket restart).
 */
export function applyCredentialChanges(
  event: CredentialChangeEvent,
  mappings: CredentialServiceMapping[],
  log: { info: (msg: string) => void },
): Set<string> {
  const changedServices = new Set<string>();
  for (const mapping of mappings) {
    if (!event[mapping.changedKey]) continue;
    // Extract a human-friendly service name from the changedKey (e.g. "telegramChanged" -> "Telegram")
    const serviceName = mapping.changedKey.replace("Changed", "");
    const capitalizedName =
      serviceName.charAt(0).toUpperCase() + serviceName.slice(1);
    const logName = mapping.displayName ?? capitalizedName;

    // Determine whether credentials were loaded or cleared by checking the
    // corresponding credentials key on the event.
    const credentialsKey = mapping.changedKey.replace(
      "Changed",
      "Credentials",
    ) as keyof CredentialChangeEvent;
    const creds = event[credentialsKey];
    log.info(
      creds
        ? `${logName} credentials loaded from credential vault`
        : `${logName} credentials cleared`,
    );
    changedServices.add(serviceName);
  }
  return changedServices;
}
