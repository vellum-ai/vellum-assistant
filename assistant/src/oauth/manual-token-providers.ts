/**
 * Providers whose credentials are pasted in rather than granted through a
 * browser flow, and what each one stores.
 *
 * Two questions are answered together because they are the same fact seen from
 * two sides, and answering them in separate tables lets them drift: which
 * fields must be present for the provider to count as configured
 * (reconciliation), and which single field an API request authenticates with
 * (token resolution). Slack stores an app token and Telegram a webhook secret,
 * and neither authenticates a request.
 *
 * `accessField` is named rather than taken as the first of `fields`, so
 * reordering that list cannot silently change which secret gets sent.
 *
 * Channel bots are keyed off the shared channel contract, so adding a channel
 * does not mean remembering this file exists. `sanity` is not in that contract
 * because it is a user's own API token: manual to enter, but not a bot and not
 * a channel.
 *
 * The gateway declares the same field sets for its own reading of these
 * credentials (`gateway/src/credential-reader.ts`). One declaration serving
 * both is worth doing and needs the specs hoisted into a shared package.
 */

import { CHANNEL_BOT_PROVIDER } from "@vellumai/service-contracts/channels";

export interface ManualTokenProviderSpec {
  /** Every field that must be present for the provider to count as connected. */
  fields: readonly string[];
  /** The one field an API request authenticates with. */
  accessField: string;
}

export const MANUAL_TOKEN_PROVIDERS: Record<string, ManualTokenProviderSpec> = {
  [CHANNEL_BOT_PROVIDER.slack]: {
    fields: ["bot_token", "app_token"],
    accessField: "bot_token",
  },
  [CHANNEL_BOT_PROVIDER.discord]: {
    fields: ["bot_token"],
    accessField: "bot_token",
  },
  [CHANNEL_BOT_PROVIDER.telegram]: {
    fields: ["bot_token", "webhook_secret"],
    accessField: "bot_token",
  },
  sanity: { fields: ["api_token"], accessField: "api_token" },
};

/**
 * The spec for a provider, or undefined when it is not a manual-token one.
 *
 * Own-property lookup so an inherited key (`constructor`, `__proto__`) reads
 * as absent rather than returning a function.
 */
export function manualTokenProvider(
  provider: string,
): ManualTokenProviderSpec | undefined {
  return Object.prototype.hasOwnProperty.call(MANUAL_TOKEN_PROVIDERS, provider)
    ? MANUAL_TOKEN_PROVIDERS[provider]
    : undefined;
}
