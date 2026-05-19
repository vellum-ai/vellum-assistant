import { and, desc, eq, like, or, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getDb } from "./db-connection.js";
import { pkbEntities, pkbEpisodes, pkbPreferences } from "./schema.js";

export interface UpsertPkbEntityInput {
  scopeId?: string;
  entityType: string;
  canonicalName: string;
  aliases?: string[];
  attributes?: Record<string, unknown>;
  confidence?: number;
  /** Optional provenance entry appended on every upsert. */
  provenance?: PkbProvenanceEntry;
  /** When true, treat this upsert as a reinforcement (bump counter + last_reinforced_at). Defaults to true. */
  reinforce?: boolean;
}

export interface PkbProvenanceEntry {
  source: string;
  sourceEventId?: string;
  observedAt: number;
  /** Optional human-readable note for audit. */
  note?: string;
}

export interface RecordPkbEpisodeInput {
  scopeId?: string;
  entityId?: string;
  summary: string;
  details?: Record<string, unknown>;
  happenedAt?: number;
  salience?: number;
  sourceConversationId?: string;
  /**
   * If set and another row exists for (scope_id, idempotency_key), the
   * existing row is returned unchanged. Recommended for perception
   * writers: pass `${sourceEventId}:${interpretedKind}`.
   */
  idempotencyKey?: string;
}

export type PreferenceSignal = "positive" | "negative";

export interface UpsertPkbPreferenceInput {
  scopeId?: string;
  key: string;
  value: string;
  confidence?: number;
  learnedFrom?: string;
  /** Direction of the new evidence. Defaults to `positive`. */
  signal?: PreferenceSignal;
}

const DEFAULT_SCOPE = "default";
const MAX_PROVENANCE_ENTRIES = 20;

export function upsertPkbEntity(input: UpsertPkbEntityInput) {
  const db = getDb();
  const now = Date.now();
  const scopeId = input.scopeId ?? DEFAULT_SCOPE;
  const entityType = input.entityType.trim();
  const canonicalName = normalizeEntityName(input.canonicalName);
  const aliases = dedupeAliases(input.aliases ?? [], canonicalName);
  const confidence = clamp01(input.confidence ?? 0.6);
  const reinforce = input.reinforce ?? true;

  const existing = db
    .select()
    .from(pkbEntities)
    .where(
      and(
        eq(pkbEntities.scopeId, scopeId),
        eq(pkbEntities.entityType, entityType),
        eq(pkbEntities.canonicalName, canonicalName),
      ),
    )
    .get();

  if (existing) {
    const mergedAliases = dedupeAliases(
      [
        ...safeJsonStringArray(existing.aliasesJson),
        ...aliases,
        existing.canonicalName,
      ],
      existing.canonicalName,
    );
    const mergedAttributes = {
      ...safeJsonObject(existing.attributesJson),
      ...(input.attributes ?? {}),
    };
    const evidenceCount = existing.evidenceCount ?? 1;
    // Counter-weighted mean — every reinforcement pulls confidence toward
    // the incoming observation but in proportion to the existing evidence.
    const mergedConfidence = reinforce
      ? clamp01(
          (evidenceCount * existing.confidence + confidence) /
            (evidenceCount + 1),
        )
      : Math.max(existing.confidence, confidence);
    const newEvidenceCount = reinforce ? evidenceCount + 1 : evidenceCount;
    const mergedProvenance = appendProvenance(
      safeJsonProvenance(existing.provenanceJson ?? "[]"),
      input.provenance,
    );

    db.update(pkbEntities)
      .set({
        aliasesJson: JSON.stringify(mergedAliases),
        attributesJson: JSON.stringify(mergedAttributes),
        confidence: mergedConfidence,
        lastSeenAt: now,
        updatedAt: now,
        evidenceCount: newEvidenceCount,
        ...(reinforce ? { lastReinforcedAt: now } : {}),
        provenanceJson: JSON.stringify(mergedProvenance),
      })
      .where(eq(pkbEntities.id, existing.id))
      .run();
    return db
      .select()
      .from(pkbEntities)
      .where(eq(pkbEntities.id, existing.id))
      .get()!;
  }

  const id = uuid();
  const initialProvenance = input.provenance ? [input.provenance] : [];
  db.insert(pkbEntities)
    .values({
      id,
      scopeId,
      entityType,
      canonicalName,
      aliasesJson: JSON.stringify(aliases),
      attributesJson: JSON.stringify(input.attributes ?? {}),
      confidence,
      firstSeenAt: now,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
      evidenceCount: 1,
      lastReinforcedAt: now,
      provenanceJson: JSON.stringify(initialProvenance),
    })
    .run();

  return db.select().from(pkbEntities).where(eq(pkbEntities.id, id)).get()!;
}

export function findPkbEntities(input: {
  scopeId?: string;
  query: string;
  limit?: number;
}) {
  const db = getDb();
  const scopeId = input.scopeId ?? DEFAULT_SCOPE;
  const needle = `%${input.query.trim().toLowerCase()}%`;
  const limit = Math.max(1, Math.min(input.limit ?? 10, 100));

  return db
    .select()
    .from(pkbEntities)
    .where(
      and(
        eq(pkbEntities.scopeId, scopeId),
        or(
          like(sql`lower(${pkbEntities.canonicalName})`, needle),
          like(sql`lower(${pkbEntities.aliasesJson})`, needle),
        ),
      ),
    )
    .orderBy(desc(pkbEntities.lastSeenAt))
    .limit(limit)
    .all();
}

export function listRecentPkbEntities(input: {
  scopeId?: string;
  limit?: number;
}) {
  const db = getDb();
  const scopeId = input.scopeId ?? DEFAULT_SCOPE;
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
  return db
    .select()
    .from(pkbEntities)
    .where(eq(pkbEntities.scopeId, scopeId))
    .orderBy(desc(pkbEntities.updatedAt))
    .limit(limit)
    .all();
}

export function recordPkbEpisode(input: RecordPkbEpisodeInput) {
  const db = getDb();
  const now = Date.now();
  const scopeId = input.scopeId ?? DEFAULT_SCOPE;
  const idempotencyKey = input.idempotencyKey?.trim() || undefined;

  if (idempotencyKey) {
    const existing = db
      .select()
      .from(pkbEpisodes)
      .where(
        and(
          eq(pkbEpisodes.scopeId, scopeId),
          eq(pkbEpisodes.idempotencyKey, idempotencyKey),
        ),
      )
      .get();
    if (existing) return existing;
  }

  const id = uuid();
  db.insert(pkbEpisodes)
    .values({
      id,
      scopeId,
      entityId: input.entityId,
      summary: input.summary.trim(),
      detailsJson: JSON.stringify(input.details ?? {}),
      happenedAt: input.happenedAt ?? now,
      salience: clamp01(input.salience ?? 0.5),
      sourceConversationId: input.sourceConversationId,
      createdAt: now,
      idempotencyKey: idempotencyKey ?? null,
    })
    .run();
  return db.select().from(pkbEpisodes).where(eq(pkbEpisodes.id, id)).get()!;
}

export function listRecentPkbEpisodes(input: {
  scopeId?: string;
  limit?: number;
}) {
  const db = getDb();
  const scopeId = input.scopeId ?? DEFAULT_SCOPE;
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
  return db
    .select()
    .from(pkbEpisodes)
    .where(eq(pkbEpisodes.scopeId, scopeId))
    .orderBy(desc(pkbEpisodes.happenedAt), desc(pkbEpisodes.createdAt))
    .limit(limit)
    .all();
}

export function upsertPkbPreference(input: UpsertPkbPreferenceInput) {
  const db = getDb();
  const now = Date.now();
  const scopeId = input.scopeId ?? DEFAULT_SCOPE;
  const key = input.key.trim();
  const value = input.value.trim();
  const learnedFrom = input.learnedFrom?.trim() || "inferred";
  const signal: PreferenceSignal = input.signal ?? "positive";

  const existing = db
    .select()
    .from(pkbPreferences)
    .where(
      and(eq(pkbPreferences.scopeId, scopeId), eq(pkbPreferences.key, key)),
    )
    .get();

  if (existing) {
    const positive =
      (existing.positiveCount ?? 1) + (signal === "positive" ? 1 : 0);
    const negative =
      (existing.negativeCount ?? 0) + (signal === "negative" ? 1 : 0);
    const evidence = (existing.evidenceCount ?? 1) + 1;
    // Beta-mean estimator — Laplace-smoothed positive ratio.
    const confidence = clamp01(positive / Math.max(1, positive + negative));
    db.update(pkbPreferences)
      .set({
        // On a contradiction, overwrite the stored value with the new
        // (negative) signal's value so the most recent observed value
        // wins. On reinforcement, the value already matches.
        value: signal === "negative" ? value : existing.value,
        confidence,
        learnedFrom,
        updatedAt: now,
        evidenceCount: evidence,
        positiveCount: positive,
        negativeCount: negative,
        ...(signal === "positive" ? { lastReinforcedAt: now } : {}),
        ...(signal === "negative" ? { lastContradictedAt: now } : {}),
      })
      .where(eq(pkbPreferences.id, existing.id))
      .run();
    return db
      .select()
      .from(pkbPreferences)
      .where(eq(pkbPreferences.id, existing.id))
      .get()!;
  }

  const id = uuid();
  const initialConfidence = clamp01(input.confidence ?? 0.6);
  db.insert(pkbPreferences)
    .values({
      id,
      scopeId,
      key,
      value,
      confidence: initialConfidence,
      learnedFrom,
      createdAt: now,
      updatedAt: now,
      evidenceCount: 1,
      positiveCount: signal === "positive" ? 1 : 0,
      negativeCount: signal === "negative" ? 1 : 0,
      ...(signal === "positive" ? { lastReinforcedAt: now } : {}),
      ...(signal === "negative" ? { lastContradictedAt: now } : {}),
    })
    .run();
  return db
    .select()
    .from(pkbPreferences)
    .where(eq(pkbPreferences.id, id))
    .get()!;
}

export function listPkbPreferences(input: {
  scopeId?: string;
  limit?: number;
}) {
  const db = getDb();
  const scopeId = input.scopeId ?? DEFAULT_SCOPE;
  const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
  return db
    .select()
    .from(pkbPreferences)
    .where(eq(pkbPreferences.scopeId, scopeId))
    .orderBy(desc(pkbPreferences.confidence), desc(pkbPreferences.updatedAt))
    .limit(limit)
    .all();
}

// ---------------------------------------------------------------------------
// Scoring helpers — used by the perception-context formatter and the
// memory-maturation feature flag's selection logic.
//
// Score = w_conf * confidence
//       + w_recent * exp(-Δt / τ)
//       + w_evidence * log(1 + evidence_count)
//
// All weights are positive; τ controls how aggressively recency decays.
// ---------------------------------------------------------------------------

export interface ScoringOptions {
  scopeId?: string;
  limit?: number;
  now?: number;
  weights?: {
    confidence?: number;
    recency?: number;
    evidence?: number;
  };
  /** Recency time constant in milliseconds. Default 14 days. */
  halfLifeMs?: number;
}

export interface ScoredEntity {
  entity: ReturnType<typeof listRecentPkbEntities>[number];
  score: number;
}

export interface ScoredPreference {
  preference: ReturnType<typeof listPkbPreferences>[number];
  score: number;
}

const DEFAULT_WEIGHTS = { confidence: 0.5, recency: 0.3, evidence: 0.2 };
const DEFAULT_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1_000;

export function scorePkbEntities(
  input: { query?: string } & ScoringOptions = {},
): ScoredEntity[] {
  const now = input.now ?? Date.now();
  const weights = { ...DEFAULT_WEIGHTS, ...(input.weights ?? {}) };
  const halfLife = Math.max(1, input.halfLifeMs ?? DEFAULT_HALF_LIFE_MS);
  const limit = Math.max(1, Math.min(input.limit ?? 20, 200));

  const rows = input.query
    ? findPkbEntities({
        scopeId: input.scopeId,
        query: input.query,
        limit: limit * 3,
      })
    : listRecentPkbEntities({ scopeId: input.scopeId, limit: limit * 3 });

  const scored: ScoredEntity[] = rows.map((entity) => {
    const anchor = entity.lastReinforcedAt ?? entity.lastSeenAt;
    const dt = Math.max(0, now - anchor);
    const recency = Math.exp(-dt / halfLife);
    const evidence = Math.log1p(entity.evidenceCount ?? 1);
    const score =
      weights.confidence * entity.confidence +
      weights.recency * recency +
      weights.evidence * evidence;
    return { entity, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

export function scorePkbPreferences(
  input: ScoringOptions = {},
): ScoredPreference[] {
  const now = input.now ?? Date.now();
  const weights = { ...DEFAULT_WEIGHTS, ...(input.weights ?? {}) };
  const halfLife = Math.max(1, input.halfLifeMs ?? DEFAULT_HALF_LIFE_MS);
  const limit = Math.max(1, Math.min(input.limit ?? 20, 200));

  const rows = listPkbPreferences({
    scopeId: input.scopeId,
    limit: limit * 3,
  });
  const scored: ScoredPreference[] = rows.map((preference) => {
    const anchor = preference.lastReinforcedAt ?? preference.updatedAt;
    const dt = Math.max(0, now - anchor);
    const recency = Math.exp(-dt / halfLife);
    const evidence = Math.log1p(preference.evidenceCount ?? 1);
    const score =
      weights.confidence * preference.confidence +
      weights.recency * recency +
      weights.evidence * evidence;
    return { preference, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function normalizeEntityName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

function dedupeAliases(aliases: string[], canonicalName: string): string[] {
  const out = new Set<string>();
  for (const alias of aliases) {
    const normalized = alias.trim().replace(/\s+/g, " ");
    if (!normalized) continue;
    if (normalized.toLowerCase() === canonicalName.toLowerCase()) continue;
    out.add(normalized);
  }
  return Array.from(out.values()).slice(0, 50);
}

function safeJsonStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

function safeJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function safeJsonProvenance(value: string): PkbProvenanceEntry[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is PkbProvenanceEntry => {
      if (!v || typeof v !== "object") return false;
      const entry = v as Record<string, unknown>;
      return (
        typeof entry.source === "string" && typeof entry.observedAt === "number"
      );
    });
  } catch {
    return [];
  }
}

function appendProvenance(
  existing: PkbProvenanceEntry[],
  entry: PkbProvenanceEntry | undefined,
): PkbProvenanceEntry[] {
  if (!entry) return existing.slice(-MAX_PROVENANCE_ENTRIES);
  const next = [...existing, entry];
  return next.slice(-MAX_PROVENANCE_ENTRIES);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
