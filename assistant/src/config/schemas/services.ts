import { z } from "zod";

import { DEFAULT_IMAGE_MODEL } from "../../media/image-models.js";
import { SEARCH_PROVIDER_IDS } from "../../providers/search-provider-catalog.js";
import { SttServiceSchema } from "./stt.js";
import { TtsServiceSchema } from "./tts.js";

export const ServiceModeSchema = z
  .enum(["managed", "your-own"])
  .meta({ id: "ServiceMode" });
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

/**
 * Derived from `SEARCH_PROVIDER_CATALOG`. Adding a new web-search provider
 * to the catalog automatically extends the config-schema enum — no edit
 * here required.
 */
const VALID_WEB_SEARCH_PROVIDERS = SEARCH_PROVIDER_IDS;

const BaseServiceSchema = z.object({
  mode: ServiceModeSchema.default("your-own"),
});

/**
 * Inference service entry. Carries no fields — routing is now governed
 * entirely by `provider_connections` rows and the `provider_connection`
 * reference on each `llm.profile`. The namespace is kept so callers
 * that walk `config.services.inference` do not need updating.
 *
 * Legacy `provider`, `model`, and `mode` fields are stripped by workspace
 * migrations `039-drop-legacy-llm-keys` and `076-drop-services-inference-mode`.
 */
const InferenceServiceSchema = z.object({});

const ImageGenerationServiceSchema = BaseServiceSchema.extend({
  provider: z.enum(VALID_IMAGE_GEN_PROVIDERS).default("gemini"),
  model: z.string().default(DEFAULT_IMAGE_MODEL),
});

const WebSearchServiceSchema = BaseServiceSchema.extend({
  // Provider choice for app-executed search in Your Own mode, or the native
  // hosted-search preference when set to `inference-provider-native`. In
  // Managed mode, non-native inference providers can still use the platform
  // managed search proxy through the app-executed `web_search` tool.
  provider: z
    .enum(VALID_WEB_SEARCH_PROVIDERS)
    .default("inference-provider-native"),
});

const GoogleOAuthServiceSchema = BaseServiceSchema.extend({
  mode: ServiceModeSchema.default("managed"),
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
  mode: ServiceModeSchema.default("managed"),
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

const DiscordOAuthServiceSchema = BaseServiceSchema.extend({
  mode: ServiceModeSchema.default("your-own"),
});

const HubspotOAuthServiceSchema = BaseServiceSchema.extend({
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
  "discord-oauth": DiscordOAuthServiceSchema.default(
    DiscordOAuthServiceSchema.parse({}),
  ),
  "hubspot-oauth": HubspotOAuthServiceSchema.default(
    HubspotOAuthServiceSchema.parse({}),
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
