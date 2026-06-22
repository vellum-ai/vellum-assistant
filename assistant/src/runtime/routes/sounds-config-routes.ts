/**
 * Dedicated routes for reading/writing the sounds configuration
 * (`data/sounds/config.json`) and listing available sound files.
 *
 * These replace the generic workspace file endpoints for sounds,
 * providing typed Zod schemas so the generated SDK produces typed
 * response helpers (`soundsConfigGetSetQueryData`, etc.).
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { getSoundsDir } from "../../util/platform.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { publishSoundsConfigUpdated } from "../sync/resource-sync-events.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const SUPPORTED_EXTENSIONS = new Set(["aiff", "wav", "mp3", "m4a", "caf"]);

const soundEventConfigSchema = z.object({
  enabled: z.boolean(),
  sounds: z.array(z.string()),
});

const soundsConfigSchema = z.object({
  globalEnabled: z.boolean(),
  volume: z.number(),
  events: z.record(z.string(), soundEventConfigSchema),
});

const lenientSoundEventSchema = z
  .object({
    enabled: z.boolean().catch(false),
    sounds: z
      .array(z.string().catch(""))
      .catch([])
      .transform((arr) => arr.filter(Boolean)),
  })
  .catch({ enabled: false, sounds: [] });

const lenientSoundsConfigSchema = z
  .object({
    globalEnabled: z.boolean().catch(false),
    volume: z
      .number()
      .catch(0.7)
      .transform((v) => Math.max(0, Math.min(1, v))),
    events: z.record(z.string(), lenientSoundEventSchema).catch({}),
  })
  .catch({ globalEnabled: false, volume: 0.7, events: {} });

const availableSoundSchema = z.object({
  label: z.string(),
  filename: z.string(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CONFIG_FILENAME = "config.json";

function configPath(): string {
  return join(getSoundsDir(), CONFIG_FILENAME);
}

const SOUND_EVENT_IDS = [
  "task_complete",
  "needs_input",
  "task_failed",
  "notification",
  "new_conversation",
  "message_sent",
  "character_poke",
  "random",
] as const;

type SoundsConfig = z.infer<typeof soundsConfigSchema>;

function defaultEvents(): Record<
  string,
  z.infer<typeof soundEventConfigSchema>
> {
  const events: Record<string, z.infer<typeof soundEventConfigSchema>> = {};
  for (const id of SOUND_EVENT_IDS) {
    events[id] = { enabled: false, sounds: [] };
  }
  return events;
}

function normalise(input: unknown): SoundsConfig {
  const parsed = lenientSoundsConfigSchema.parse(input);
  const mergedEvents = { ...defaultEvents(), ...parsed.events };
  return { ...parsed, events: mergedEvents };
}

function readConfig(): SoundsConfig {
  const path = configPath();
  try {
    const text = readFileSync(path, "utf-8");
    return normalise(JSON.parse(text));
  } catch {
    return normalise(undefined);
  }
}

function writeConfig(config: SoundsConfig): void {
  const dir = getSoundsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(configPath(), JSON.stringify(config, null, 2), "utf-8");
}

function hasSupportedExtension(filename: string): boolean {
  const idx = filename.lastIndexOf(".");
  if (idx < 0 || idx === filename.length - 1) return false;
  return SUPPORTED_EXTENSIONS.has(filename.slice(idx + 1).toLowerCase());
}

function displayLabel(filename: string): string {
  const idx = filename.lastIndexOf(".");
  if (idx <= 0) return filename;
  return filename.slice(0, idx);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleGetSoundsConfig() {
  return readConfig();
}

function handlePutSoundsConfig({ body }: RouteHandlerArgs) {
  if (!body) {
    throw new BadRequestError("Request body is required");
  }
  const parsed = soundsConfigSchema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError(`Invalid sounds config: ${parsed.error.message}`);
  }
  const config: SoundsConfig = {
    ...parsed.data,
    volume: Math.max(0, Math.min(1, parsed.data.volume)),
    events: { ...defaultEvents(), ...parsed.data.events },
  };
  writeConfig(config);
  publishSoundsConfigUpdated();
  return config;
}

function handleListAvailableSounds() {
  const dir = getSoundsDir();
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    const sounds: Array<{ label: string; filename: string }> = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      if (name === CONFIG_FILENAME) continue;
      if (!hasSupportedExtension(name)) continue;
      sounds.push({ label: displayLabel(name), filename: name });
    }
    sounds.sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
    );
    return { sounds };
  } catch {
    return { sounds: [] };
  }
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "sounds_config_get",
    endpoint: "sounds/config",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get sounds configuration",
    description:
      "Return the sounds configuration from data/sounds/config.json, normalised with defaults.",
    tags: ["sounds"],
    responseBody: soundsConfigSchema,
    handler: handleGetSoundsConfig,
  },
  {
    operationId: "sounds_config_put",
    endpoint: "sounds/config",
    method: "PUT",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Update sounds configuration",
    description: "Replace the sounds configuration in data/sounds/config.json.",
    tags: ["sounds"],
    requestBody: soundsConfigSchema,
    responseBody: soundsConfigSchema,
    handler: handlePutSoundsConfig,
  },
  {
    operationId: "sounds_available_get",
    endpoint: "sounds/available",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List available sound files",
    description:
      "Return audio files in data/sounds/ that can be assigned to sound events.",
    tags: ["sounds"],
    responseBody: z.object({
      sounds: z.array(availableSoundSchema),
    }),
    handler: handleListAvailableSounds,
  },
];
