/**
 * Reading the publish target off a publish or publish-status response.
 *
 * Which target an app publishes to is the assistant's `apps.publish.provider`
 * setting, so every surface that names the target reads it off the response
 * rather than saying "Vercel".
 */

export interface PublishProviderFields {
  provider?: string;
  providerName?: string;
}

/**
 * An assistant older than pluggable publish providers omits `provider` from
 * its publish responses, and the only target it ever had was Vercel, so the
 * omission names Vercel exactly. Also the name shown until a status read has
 * answered, since an unanswered assistant is indistinguishable from that one.
 */
const LEGACY_PROVIDER_ID = "vercel";
export const DEFAULT_PUBLISH_PROVIDER_NAME = "Vercel";

/** Display name of the publish target a publish or status response names. */
export function publishProviderName(fields?: PublishProviderFields): string {
  return fields?.providerName || DEFAULT_PUBLISH_PROVIDER_NAME;
}

/**
 * Whether the response names Vercel. Gates the Vercel-specific token dialog:
 * every other provider reports a missing credential as an ordinary error.
 */
export function isVercelPublishProvider(
  fields?: PublishProviderFields,
): boolean {
  return (fields?.provider || LEGACY_PROVIDER_ID) === LEGACY_PROVIDER_ID;
}
