import { z } from "zod";

import { SttServiceSchema } from "./stt.js";
import { TtsServiceSchema } from "./tts.js";

const ServiceModeSchema = z.enum(["managed", "your-own"]);
type ServiceMode = z.infer<typeof ServiceModeSchema>;

export const VALID_INFERENCE_PROVIDERS = [
  "anthropic",
  "openai",
  "gemini",
  "ollama",
  "fireworks",
  "openrouter",
] as const;

const VALID_IMAGE_GEN_PROVIDERS = ["gemini", "openai"] as const;

const VALID_WEB_SEARCH_PROVIDERS = [
  "perplexity",
  "brave",
  "inference-provider-native",
] as const;

const BaseServiceSchema = z.object({
  mode: ServiceModeSchema.default("your-own"),
});

/**
 * Inference service entry. Carries only the routing `mode`
 * (`managed` vs `your-own`) — the provider and model live under
 * `llm.default.{provider, model}` (see `schemas/llm.ts`). PR 19 of the
 * unify-llm-callsites plan removed the `provider` and `model` fields here;
 * legacy configs that still carry them have those keys stripped by
 * workspace migration `039-drop-legacy-llm-keys`.
 */
const InferenceServiceSchema = BaseServiceSchema;

const ImageGenerationServiceSchema = BaseServiceSchema.extend({
  provider: z.enum(VALID_IMAGE_GEN_PROVIDERS).default("gemini"),
  model: z.string().default("gemini-3.1-flash-image-preview"),
});

const WebSearchServiceSchema = BaseServiceSchema.extend({
  provider: z
    .enum(VALID_WEB_SEARCH_PROVIDERS)
    .default("inference-provider-native"),
});

const GoogleOAuthServiceSchema = BaseServiceSchema.extend({
  mode: ServiceModeSchema.default("your-own"),
});

const OutlookOAuthServiceSchema = BaseServiceSchema.extend({
  mode: ServiceModeSchema.default("your-own"),
});

const LinearOAuthServiceSchema = BaseServiceSchema.extend({
  mode: ServiceModeSchema.default("your-own"),
});

const GitHubOAuthServiceSchema = BaseServiceSchema.extend({
  mode: ServiceModeSchema.default("your-own"),
});

const NotionOAuthServiceSchema = BaseServiceSchema.extend({
  mode: ServiceModeSchema.default("your-own"),
});

const TwitterOAuthServiceSchema = BaseServiceSchema.extend({
  mode: ServiceModeSchema.default("your-own"),
});

const AsanaOAuthServiceSchema = BaseServiceSchema.extend({
  mode: ServiceModeSchema.default("your-own"),
});

const TodoistOAuthServiceSchema = BaseServiceSchema.extend({
  mode: ServiceModeSchema.default("your-own"),
});

const DropboxOAuthServiceSchema = BaseServiceSchema.extend({
  mode: ServiceModeSchema.default("your-own"),
});

const DiscordOAuthServiceSchema = BaseServiceSchema.extend({
  mode: ServiceModeSchema.default("your-own"),
});

const AirtableOAuthServiceSchema = BaseServiceSchema.extend({
  mode: ServiceModeSchema.default("your-own"),
});

const HubspotOAuthServiceSchema = BaseServiceSchema.extend({
  mode: ServiceModeSchema.default("your-own"),
});

const SalesforceOAuthServiceSchema = BaseServiceSchema.extend({
  mode: ServiceModeSchema.default("your-own"),
});

/**
 * `services.meet.host.*` — daemon-side knobs for the externalized meet-join
 * skill process. Kept narrow: only the values the daemon reads before the
 * meet-host child is spawned live here. Skill-internal configuration
 * (avatar renderer, consent copy, proactive-chat keywords, etc.) lives in
 * `skills/meet-join/config-schema.ts` and is sourced from the separate
 * `<workspace>/config/meet.json` file the skill owns.
 */
const MeetHostConfigSchema = z
  .object({
    idle_timeout_ms: z
      .number({
        error: "services.meet.host.idle_timeout_ms must be a number",
      })
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Idle window in milliseconds after the last active meet session closes before the meet-host child is shut down. Defaults to 5 minutes when unset.",
      ),
  })
  .describe("Daemon-side configuration for the external meet-join skill host");

/**
 * Daemon-side `services.meet` block. Intentionally distinct from the
 * skill-internal `MeetServiceSchema` in `skills/meet-join/config-schema.ts`,
 * which validates the bot-facing `<workspace>/config/meet.json` file. This
 * schema only describes the keys the assistant itself reads from its global
 * `config.json` before the meet-host child process is spawned.
 */
const MeetDaemonServiceSchema = z
  .object({
    host: MeetHostConfigSchema.default(MeetHostConfigSchema.parse({})),
  })
  .describe("meet-join skill daemon-side configuration");

export const ServicesSchema = z.object({
  inference: InferenceServiceSchema.default(InferenceServiceSchema.parse({})),
  "image-generation": ImageGenerationServiceSchema.default(
    ImageGenerationServiceSchema.parse({}),
  ),
  "web-search": WebSearchServiceSchema.default(
    WebSearchServiceSchema.parse({}),
  ),
  stt: SttServiceSchema.default({
    mode: "your-own" as const,
    provider: "deepgram" as const,
    providers: {},
  }),
  tts: TtsServiceSchema.default(TtsServiceSchema.parse({})),
  "google-oauth": GoogleOAuthServiceSchema.default(
    GoogleOAuthServiceSchema.parse({}),
  ),
  "outlook-oauth": OutlookOAuthServiceSchema.default(
    OutlookOAuthServiceSchema.parse({}),
  ),
  "linear-oauth": LinearOAuthServiceSchema.default(
    LinearOAuthServiceSchema.parse({}),
  ),
  "github-oauth": GitHubOAuthServiceSchema.default(
    GitHubOAuthServiceSchema.parse({}),
  ),
  "notion-oauth": NotionOAuthServiceSchema.default(
    NotionOAuthServiceSchema.parse({}),
  ),
  "twitter-oauth": TwitterOAuthServiceSchema.default(
    TwitterOAuthServiceSchema.parse({}),
  ),
  "asana-oauth": AsanaOAuthServiceSchema.default(
    AsanaOAuthServiceSchema.parse({}),
  ),
  "todoist-oauth": TodoistOAuthServiceSchema.default(
    TodoistOAuthServiceSchema.parse({}),
  ),
  "dropbox-oauth": DropboxOAuthServiceSchema.default(
    DropboxOAuthServiceSchema.parse({}),
  ),
  "discord-oauth": DiscordOAuthServiceSchema.default(
    DiscordOAuthServiceSchema.parse({}),
  ),
  "airtable-oauth": AirtableOAuthServiceSchema.default(
    AirtableOAuthServiceSchema.parse({}),
  ),
  "hubspot-oauth": HubspotOAuthServiceSchema.default(
    HubspotOAuthServiceSchema.parse({}),
  ),
  "salesforce-oauth": SalesforceOAuthServiceSchema.default(
    SalesforceOAuthServiceSchema.parse({}),
  ),
  meet: MeetDaemonServiceSchema.default(MeetDaemonServiceSchema.parse({})),
});
export type Services = z.infer<typeof ServicesSchema>;

/**
 * Safely read the `mode` of a `services.*` entry.
 *
 * Most service entries (OAuth providers, inference, etc.) extend
 * `BaseServiceSchema` and therefore carry a `mode: "managed" | "your-own"`
 * field.
 *
 * Returns `undefined` when the requested service entry has no `mode` field,
 * so callers can treat those entries as implicitly "your-own" without the
 * compiler tripping on a union widened by non-BaseService members.
 */
export function getServiceMode(
  services: Services,
  key: keyof Services,
): ServiceMode | undefined {
  const entry = services[key] as { mode?: ServiceMode };
  return entry.mode;
}
