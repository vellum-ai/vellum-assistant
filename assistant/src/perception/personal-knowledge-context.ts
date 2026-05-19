import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getConfig } from "../config/loader.js";
import {
  listPkbPreferences,
  listRecentPkbEntities,
  listRecentPkbEpisodes,
  scorePkbEntities,
  scorePkbPreferences,
} from "../memory/personal-knowledge-store.js";

const DEFAULT_SCOPE_ID = "default";
const DEFAULT_ENTITY_LIMIT = 5;
const DEFAULT_EPISODE_LIMIT = 5;
const DEFAULT_PREFERENCE_LIMIT = 5;
const MAX_SECTION_TEXT = 180;

export function buildPerceptionKnowledgeContext(options?: {
  scopeId?: string;
  entityLimit?: number;
  episodeLimit?: number;
  preferenceLimit?: number;
}): string | null {
  const scopeId = options?.scopeId ?? DEFAULT_SCOPE_ID;
  const entityLimit = clampLimit(
    options?.entityLimit,
    DEFAULT_ENTITY_LIMIT,
    20,
  );
  const episodeLimit = clampLimit(
    options?.episodeLimit,
    DEFAULT_EPISODE_LIMIT,
    20,
  );
  const preferenceLimit = clampLimit(
    options?.preferenceLimit,
    DEFAULT_PREFERENCE_LIMIT,
    20,
  );

  // When memory-maturation is enabled, switch from "most recent" selection to
  // scoring-based selection so high-decay items naturally fall out of the
  // prompt block. The episode list stays recency-ordered — scoring would
  // require an additional confidence/decay signal we don't track on episodes
  // yet, and the existing recency order already provides what the prompt
  // needs.
  const maturationEnabled = isAssistantFeatureFlagEnabled(
    "memory-maturation",
    getConfig(),
  );

  const entities = maturationEnabled
    ? scorePkbEntities({ scopeId, limit: entityLimit }).map((s) => s.entity)
    : listRecentPkbEntities({ scopeId, limit: entityLimit });
  const episodes = listRecentPkbEpisodes({ scopeId, limit: episodeLimit });
  const preferences = maturationEnabled
    ? scorePkbPreferences({ scopeId, limit: preferenceLimit }).map(
        (s) => s.preference,
      )
    : listPkbPreferences({ scopeId, limit: preferenceLimit });

  if (
    entities.length === 0 &&
    episodes.length === 0 &&
    preferences.length === 0
  ) {
    return null;
  }

  const sections: string[] = [];

  if (episodes.length > 0) {
    sections.push(
      "### Recent perceived episodes",
      ...episodes.map((episode) => `- ${trimText(episode.summary)}`),
    );
  }

  if (entities.length > 0) {
    sections.push(
      "### Active perceived entities",
      ...entities.map(
        (entity) =>
          `- ${entity.entityType}: ${trimText(entity.canonicalName)} (confidence ${entity.confidence.toFixed(2)})`,
      ),
    );
  }

  if (preferences.length > 0) {
    sections.push(
      "### Learned preferences",
      ...preferences.map(
        (pref) =>
          `- ${pref.key} = ${trimText(pref.value)} (confidence ${pref.confidence.toFixed(2)})`,
      ),
    );
  }

  return sections.join("\n");
}

function trimText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_SECTION_TEXT) return normalized;
  return `${normalized.slice(0, MAX_SECTION_TEXT - 1)}…`;
}

function clampLimit(
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  const raw = Number.isFinite(value) ? Math.trunc(value!) : fallback;
  if (raw < 1) return 1;
  if (raw > max) return max;
  return raw;
}
