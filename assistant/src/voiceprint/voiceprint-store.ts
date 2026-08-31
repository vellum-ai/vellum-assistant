/**
 * Persistence and matching for contact voice profiles.
 *
 * Enrollment stores one averaged embedding per contact per model.
 * Recognition scores a clip against every stored profile for the
 * active model and returns the ranking.
 *
 * The score is a similarity, not a verdict. Callers decide what to do
 * with a weak match, and nothing here may be used to grant access.
 */

import { and, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getDb } from "../persistence/db-connection.js";
import { contacts, contactVoiceprints } from "../persistence/schema/index.js";
import {
  averageEmbeddings,
  cosineSimilarity,
  EMBEDDING_DIM,
  VOICEPRINT_MODEL_ID,
} from "./embedder.js";

/**
 * Default match cutoff.
 *
 * UNTUNED. On synthetic voices, same-speaker pairs scored 0.96 and the
 * closest different-speaker pair scored 0.45, so anything in that gap
 * separates them. Real speakers sit much closer together, so treat this
 * as a starting point and re-derive it from real recordings before
 * relying on it. Callers get the raw score either way.
 */
export const DEFAULT_MATCH_THRESHOLD = 0.7;

export interface Voiceprint {
  id: string;
  contactId: string;
  label: string | null;
  dim: number;
  modelId: string;
  clipCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface VoiceprintMatch {
  contactId: string;
  displayName: string;
  voiceprintId: string;
  score: number;
}

export interface IdentifyResult {
  /** Every enrolled profile, best score first. */
  ranked: VoiceprintMatch[];
  /** Top match if it cleared the threshold, else null. */
  best: VoiceprintMatch | null;
  /** Gap between the top two scores; null when fewer than two profiles. */
  margin: number | null;
  threshold: number;
}

export class VoiceprintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceprintError";
  }
}

// ── Encoding ────────────────────────────────────────────────

/**
 * Float32Array to Buffer without copying the underlying bytes.
 * SQLite stores the raw little-endian float32 run.
 */
function encodeEmbedding(embedding: Float32Array): Buffer {
  return Buffer.from(
    embedding.buffer,
    embedding.byteOffset,
    embedding.byteLength,
  );
}

function decodeEmbedding(blob: Buffer, dim: number): Float32Array {
  if (blob.byteLength !== dim * 4) {
    throw new VoiceprintError(
      `Stored embedding is ${blob.byteLength} bytes, expected ${dim * 4} for dim ${dim}`,
    );
  }
  // Copy rather than view: a Buffer from SQLite may sit at a byte
  // offset that is not a multiple of 4, which Float32Array rejects.
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}

// ── Writes ──────────────────────────────────────────────────

/**
 * Enroll or replace a contact's voice profile.
 *
 * Several embeddings are averaged into one profile, which is the
 * cheapest accuracy win available: it averages away room, mic, and
 * mood variation that a single clip bakes in.
 *
 * Re-enrolling replaces the existing profile for this model rather
 * than accumulating, so a bad enrollment is fixed by redoing it.
 */
export function enrollVoiceprint(params: {
  contactId: string;
  embeddings: Float32Array[];
  label?: string | null;
}): Voiceprint {
  const { contactId, embeddings, label = null } = params;
  if (embeddings.length === 0) {
    throw new VoiceprintError("Need at least one embedding to enroll");
  }

  const db = getDb();
  const contact = db
    .select()
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .get();
  if (!contact) {
    throw new VoiceprintError(`No contact with id ${contactId}`);
  }

  const profile = averageEmbeddings(embeddings);
  const now = Date.now();

  const existing = db
    .select()
    .from(contactVoiceprints)
    .where(
      and(
        eq(contactVoiceprints.contactId, contactId),
        eq(contactVoiceprints.modelId, VOICEPRINT_MODEL_ID),
      ),
    )
    .get();

  const row = {
    id: existing?.id ?? uuid(),
    contactId,
    label,
    embedding: encodeEmbedding(profile),
    dim: profile.length,
    modelId: VOICEPRINT_MODEL_ID,
    clipCount: embeddings.length,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  if (existing) {
    db.update(contactVoiceprints)
      .set({
        label: row.label,
        embedding: row.embedding,
        dim: row.dim,
        clipCount: row.clipCount,
        updatedAt: row.updatedAt,
      })
      .where(eq(contactVoiceprints.id, existing.id))
      .run();
  } else {
    db.insert(contactVoiceprints).values(row).run();
  }

  return toVoiceprint(row);
}

/** Delete one profile. Returns whether a row was removed. */
export function deleteVoiceprint(voiceprintId: string): boolean {
  const db = getDb();
  const existing = db
    .select()
    .from(contactVoiceprints)
    .where(eq(contactVoiceprints.id, voiceprintId))
    .get();
  if (!existing) {
    return false;
  }
  db.delete(contactVoiceprints)
    .where(eq(contactVoiceprints.id, voiceprintId))
    .run();
  return true;
}

/** Rename a profile's free-text label. */
export function updateVoiceprintLabel(
  voiceprintId: string,
  label: string | null,
): Voiceprint | null {
  const db = getDb();
  db.update(contactVoiceprints)
    .set({ label, updatedAt: Date.now() })
    .where(eq(contactVoiceprints.id, voiceprintId))
    .run();
  const row = db
    .select()
    .from(contactVoiceprints)
    .where(eq(contactVoiceprints.id, voiceprintId))
    .get();
  return row ? toVoiceprint(row) : null;
}

// ── Reads ───────────────────────────────────────────────────

type VoiceprintRow = typeof contactVoiceprints.$inferSelect;

function toVoiceprint(row: VoiceprintRow): Voiceprint {
  return {
    id: row.id,
    contactId: row.contactId,
    label: row.label,
    dim: row.dim,
    modelId: row.modelId,
    clipCount: row.clipCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Profiles for one contact, across every model. */
export function listVoiceprintsForContact(contactId: string): Voiceprint[] {
  return getDb()
    .select()
    .from(contactVoiceprints)
    .where(eq(contactVoiceprints.contactId, contactId))
    .all()
    .map(toVoiceprint);
}

/** Every contact id that has a profile for the active model. */
export function listEnrolledContactIds(): string[] {
  return getDb()
    .select({ contactId: contactVoiceprints.contactId })
    .from(contactVoiceprints)
    .where(eq(contactVoiceprints.modelId, VOICEPRINT_MODEL_ID))
    .all()
    .map((r) => r.contactId);
}

// ── Matching ────────────────────────────────────────────────

/**
 * Score an embedding against every enrolled profile.
 *
 * Only profiles from the active model are considered. Embeddings from
 * a different model are not comparable, and scoring them anyway would
 * produce confident-looking noise.
 */
export function identifySpeaker(
  embedding: Float32Array,
  threshold: number = DEFAULT_MATCH_THRESHOLD,
): IdentifyResult {
  if (embedding.length !== EMBEDDING_DIM) {
    throw new VoiceprintError(
      `Query embedding has dim ${embedding.length}, expected ${EMBEDDING_DIM}`,
    );
  }

  const rows = getDb()
    .select({
      voiceprintId: contactVoiceprints.id,
      contactId: contactVoiceprints.contactId,
      embedding: contactVoiceprints.embedding,
      dim: contactVoiceprints.dim,
      displayName: contacts.displayName,
    })
    .from(contactVoiceprints)
    .innerJoin(contacts, eq(contactVoiceprints.contactId, contacts.id))
    .where(eq(contactVoiceprints.modelId, VOICEPRINT_MODEL_ID))
    .all();

  const ranked: VoiceprintMatch[] = rows
    .map((row) => ({
      contactId: row.contactId,
      displayName: row.displayName,
      voiceprintId: row.voiceprintId,
      score: cosineSimilarity(
        embedding,
        decodeEmbedding(row.embedding as Buffer, row.dim),
      ),
    }))
    .sort((a, b) => b.score - a.score);

  const top = ranked[0];
  return {
    ranked,
    best: top && top.score >= threshold ? top : null,
    margin: ranked.length > 1 ? ranked[0]!.score - ranked[1]!.score : null,
    threshold,
  };
}
