/**
 * Tests for the voiceprint store.
 *
 * Uses the real DB via `initializeDb()`, like the other contact
 * tests. The test preload points the workspace at a per-file temp
 * directory, so these rows land in a throwaway database.
 *
 * Embeddings here are synthetic unit vectors, not model output:
 * the store's job is round-tripping bytes and ranking scores, and
 * the model itself is covered by the fbank parity test.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { getDb } from "../../persistence/db-connection.js";
import { initializeDb } from "../../persistence/db-init.js";
import {
  contacts,
  contactVoiceprints,
} from "../../persistence/schema/index.js";
import { EMBEDDING_DIM } from "../embedder.js";
import {
  DEFAULT_MATCH_THRESHOLD,
  deleteVoiceprint,
  enrollVoiceprint,
  identifySpeaker,
  listEnrolledContactIds,
  listVoiceprintsForContact,
  updateVoiceprintLabel,
  VoiceprintError,
} from "../voiceprint-store.js";

await initializeDb();

/** Deterministic unit vector, distinct per seed. */
function unitVector(seed: number): Float32Array {
  const v = new Float32Array(EMBEDDING_DIM);
  let x = seed * 9301 + 49297;
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    x = (x * 9301 + 49297) % 233280;
    v[i] = x / 233280 - 0.5;
  }
  let sum = 0;
  for (const value of v) {
    sum += value * value;
  }
  const norm = Math.sqrt(sum);
  for (let i = 0; i < v.length; i++) {
    v[i]! /= norm;
  }
  return v;
}

/** Nudge a vector slightly, standing in for another clip of one speaker. */
function nearby(base: Float32Array, amount: number): Float32Array {
  const v = new Float32Array(base.length);
  const noise = unitVector(999);
  for (let i = 0; i < base.length; i++) {
    v[i] = base[i]! + noise[i]! * amount;
  }
  let sum = 0;
  for (const value of v) {
    sum += value * value;
  }
  const norm = Math.sqrt(sum);
  for (let i = 0; i < v.length; i++) {
    v[i]! /= norm;
  }
  return v;
}

function makeContact(id: string, displayName: string): void {
  const now = Date.now();
  getDb()
    .insert(contacts)
    .values({ id, displayName, createdAt: now, updatedAt: now })
    .run();
}

beforeEach(() => {
  getDb().delete(contactVoiceprints).run();
  getDb().delete(contacts).run();
});

describe("enrollment", () => {
  test("stores a profile and round-trips the embedding exactly", () => {
    makeContact("c1", "Alex");
    const emb = unitVector(1);
    const saved = enrollVoiceprint({ contactId: "c1", embeddings: [emb] });

    expect(saved.contactId).toBe("c1");
    expect(saved.dim).toBe(EMBEDDING_DIM);
    expect(saved.clipCount).toBe(1);

    // A self-match must score 1.0, which only holds if the bytes
    // survived the blob round trip intact.
    const result = identifySpeaker(emb);
    expect(result.ranked).toHaveLength(1);
    expect(result.ranked[0]!.score).toBeCloseTo(1.0, 5);
    expect(result.best?.contactId).toBe("c1");
  });

  test("averages several clips into one profile", () => {
    makeContact("c1", "Alex");
    const base = unitVector(1);
    const saved = enrollVoiceprint({
      contactId: "c1",
      embeddings: [base, nearby(base, 0.1), nearby(base, 0.2)],
    });
    expect(saved.clipCount).toBe(3);
    expect(listVoiceprintsForContact("c1")).toHaveLength(1);
  });

  test("re-enrolling replaces rather than accumulates", () => {
    makeContact("c1", "Alex");
    const first = enrollVoiceprint({
      contactId: "c1",
      embeddings: [unitVector(1)],
    });
    const second = enrollVoiceprint({
      contactId: "c1",
      embeddings: [unitVector(2)],
    });

    expect(listVoiceprintsForContact("c1")).toHaveLength(1);
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    // The newer embedding is the one that matches now.
    expect(identifySpeaker(unitVector(2)).ranked[0]!.score).toBeCloseTo(1.0, 5);
  });

  test("rejects an unknown contact", () => {
    expect(() =>
      enrollVoiceprint({ contactId: "nope", embeddings: [unitVector(1)] }),
    ).toThrow(VoiceprintError);
  });

  test("rejects an empty embedding list", () => {
    makeContact("c1", "Alex");
    expect(() => enrollVoiceprint({ contactId: "c1", embeddings: [] })).toThrow(
      VoiceprintError,
    );
  });
});

describe("identification", () => {
  beforeEach(() => {
    makeContact("alex", "Alex");
    makeContact("sam", "Sam");
    enrollVoiceprint({ contactId: "alex", embeddings: [unitVector(1)] });
    enrollVoiceprint({ contactId: "sam", embeddings: [unitVector(2)] });
  });

  test("ranks the right contact first and reports a margin", () => {
    const result = identifySpeaker(nearby(unitVector(1), 0.05));

    expect(result.ranked).toHaveLength(2);
    expect(result.ranked[0]!.contactId).toBe("alex");
    expect(result.ranked[0]!.displayName).toBe("Alex");
    expect(result.margin).not.toBeNull();
    expect(result.margin!).toBeGreaterThan(0);
  });

  test("returns no best match when nothing clears the threshold", () => {
    // An unrelated vector should not resemble either profile.
    const result = identifySpeaker(unitVector(4242));
    expect(result.best).toBeNull();
    // The ranking is still returned so callers can see the scores.
    expect(result.ranked).toHaveLength(2);
  });

  test("honors a caller-supplied threshold", () => {
    const query = unitVector(1);
    expect(identifySpeaker(query, 0.99).best?.contactId).toBe("alex");
    expect(identifySpeaker(query, 1.01).best).toBeNull();
  });

  test("defaults to the documented threshold", () => {
    expect(identifySpeaker(unitVector(1)).threshold).toBe(
      DEFAULT_MATCH_THRESHOLD,
    );
  });

  test("rejects a query of the wrong dimension", () => {
    expect(() => identifySpeaker(new Float32Array(8))).toThrow(VoiceprintError);
  });

  test("returns an empty ranking when nobody is enrolled", () => {
    getDb().delete(contactVoiceprints).run();
    const result = identifySpeaker(unitVector(1));
    expect(result.ranked).toHaveLength(0);
    expect(result.best).toBeNull();
    expect(result.margin).toBeNull();
  });
});

describe("management", () => {
  test("lists enrolled contacts", () => {
    makeContact("c1", "Alex");
    makeContact("c2", "Sam");
    enrollVoiceprint({ contactId: "c1", embeddings: [unitVector(1)] });
    expect(listEnrolledContactIds()).toEqual(["c1"]);
  });

  test("renames a label", () => {
    makeContact("c1", "Alex");
    const saved = enrollVoiceprint({
      contactId: "c1",
      embeddings: [unitVector(1)],
    });
    expect(updateVoiceprintLabel(saved.id, "office mic")?.label).toBe(
      "office mic",
    );
  });

  test("deletes a profile and reports whether it existed", () => {
    makeContact("c1", "Alex");
    const saved = enrollVoiceprint({
      contactId: "c1",
      embeddings: [unitVector(1)],
    });
    expect(deleteVoiceprint(saved.id)).toBe(true);
    expect(deleteVoiceprint(saved.id)).toBe(false);
    expect(listVoiceprintsForContact("c1")).toHaveLength(0);
  });

  test("deleting a contact cascades to its voiceprints", () => {
    makeContact("c1", "Alex");
    enrollVoiceprint({ contactId: "c1", embeddings: [unitVector(1)] });
    getDb().delete(contacts).run();
    expect(listVoiceprintsForContact("c1")).toHaveLength(0);
  });
});
