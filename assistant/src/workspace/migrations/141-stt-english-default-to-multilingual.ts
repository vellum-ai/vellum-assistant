import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Put existing assistants on code-switching by writing
 * `services.stt.language: "multi"` on Deepgram and the managed relay,
 * covering both an accepted English default and a language that was never
 * set at all.
 *
 * Normally rewriting a value the user set would be off limits. It is safe
 * here because of when the field appeared: `services.stt.language` did not
 * exist before the language picker shipped (#39546, released 2026-07-31), and
 * on these two providers that picker never offered English and Multilingual
 * as peers. The only English row was the default row, labelled "English
 * (default)". So an `"en"` on Deepgram or the managed relay records "I
 * accepted the default", not "I want English rather than code-switching", and
 * the default it accepted has since changed.
 *
 * Scoped deliberately:
 *
 *   - Only `"en"` and absent. Any other language is a real choice from a list
 *     where it was the only way to get that language.
 *   - Only Deepgram and the managed relay (`mode: "managed"` routes there
 *     while `provider` holds the bring-your-own restore value). xAI has
 *     offered an explicit English row since the picker shipped, so an `"en"`
 *     there is deliberate, and code-switching is a Deepgram mode its adapter
 *     drops anyway.
 *
 * Idempotent: an assistant already on `"multi"` (or anything else) is left
 * alone, so re-running changes nothing.
 */
const MULTILINGUAL = "multi";
const ENGLISH = "en";
const MULTI_DEFAULT_PROVIDERS = new Set(["deepgram", "vellum"]);

export const sttEnglishDefaultToMultilingualMigration: WorkspaceMigration = {
  id: "141-stt-english-default-to-multilingual",
  description:
    "Move services.stt.language from the accepted English default to multilingual on Deepgram and managed speech",
  run(workspaceDir: string): void {
    if (process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH) {
      return;
    }

    const configPath = join(workspaceDir, "config.json");
    if (!existsSync(configPath)) {
      return;
    }

    let config: Record<string, unknown> = {};
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return;
      }
      config = raw as Record<string, unknown>;
    } catch {
      return;
    }

    const services = readObject(config.services);
    if (services === null) {
      return;
    }
    const stt = readObject(services.stt);
    if (stt === null) {
      return;
    }
    // Two states move, and only these two. An accepted English default, and
    // an absent language.
    //
    // Absent has to be handled here rather than left to the schema default,
    // because the config route serves the RAW config: the parsed default
    // never reaches the web, so the settings UI would keep reading an absent
    // language as English while live transcription used multilingual. Writing
    // it makes the two agree.
    const language = stt.language;
    if (language !== ENGLISH && language !== undefined) {
      return;
    }

    // A legacy managed-mode config routes to the relay while `provider` still
    // holds the bring-your-own value it would restore, so mode wins.
    const provider =
      stt.mode === "managed"
        ? "vellum"
        : typeof stt.provider === "string"
          ? stt.provider
          : "deepgram";
    if (!MULTI_DEFAULT_PROVIDERS.has(provider)) {
      return;
    }

    stt.language = MULTILINGUAL;
    services.stt = stt;
    config.services = services;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
  down(_workspaceDir: string): void {
    // Forward-only.
  },
};

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
