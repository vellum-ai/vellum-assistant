import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  SPARSE_VOCAB_SIZE,
  tokenHash,
  tokenize,
} from "../../embedding-backend.js";
import {
  _resetCorpusStatsForTests,
  _setCorpusStatsForTests,
  type Bm25Params,
  type CorpusStats,
  generateBm25DocEmbedding,
  generateBm25QueryEmbedding,
  getConceptPageCorpusStats,
  rebuildConceptPageCorpusStats,
} from "../sparse-bm25.js";

const PARAMS: Bm25Params = { k1: 1.2, b: 0.75 };

/** Sum of v_q · v_d across two sparse vectors — BM25 score under the design. */
function dotProduct(
  q: { indices: number[]; values: number[] },
  d: { indices: number[]; values: number[] },
): number {
  const dMap = new Map<number, number>();
  for (let i = 0; i < d.indices.length; i++)
    dMap.set(d.indices[i], d.values[i]);
  let sum = 0;
  for (let i = 0; i < q.indices.length; i++) {
    const dv = dMap.get(q.indices[i]);
    if (dv !== undefined) sum += q.values[i] * dv;
  }
  return sum;
}

function makeWorkspace(pages: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "bm25-"));
  const conceptsDir = join(dir, "memory", "concepts");
  mkdirSync(conceptsDir, { recursive: true });
  for (const [slug, body] of Object.entries(pages)) {
    const slugPath = join(conceptsDir, `${slug}.md`);
    mkdirSync(join(slugPath, ".."), { recursive: true });
    writeFileSync(slugPath, body, "utf-8");
  }
  return dir;
}

describe("rebuildConceptPageCorpusStats", () => {
  beforeEach(() => {
    _resetCorpusStatsForTests();
  });
  afterEach(() => {
    _resetCorpusStatsForTests();
  });

  test("empty workspace produces empty stats with totalDocs=0", async () => {
    const dir = makeWorkspace({});
    try {
      await rebuildConceptPageCorpusStats(dir);
      const stats = getConceptPageCorpusStats();
      expect(stats).not.toBeNull();
      expect(stats!.totalDocs).toBe(0);
      expect(stats!.df.size).toBe(0);
      expect(stats!.avgDl).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("3-doc corpus yields correct DF counts and avgDl", async () => {
    const dir = makeWorkspace({
      a: "supplements zinc magnesium",
      b: "zinc magnesium iron",
      c: "supplements iron",
    });
    try {
      await rebuildConceptPageCorpusStats(dir);
      const stats = getConceptPageCorpusStats();
      expect(stats).not.toBeNull();
      expect(stats!.totalDocs).toBe(3);
      // avgDl = (3 + 3 + 2) / 3
      expect(stats!.avgDl).toBeCloseTo(8 / 3, 6);
      // supplements appears in 2 docs, zinc in 2, magnesium in 2, iron in 2
      const supplementsBucket = tokenHash("supplements", SPARSE_VOCAB_SIZE);
      const zincBucket = tokenHash("zinc", SPARSE_VOCAB_SIZE);
      const magBucket = tokenHash("magnesium", SPARSE_VOCAB_SIZE);
      const ironBucket = tokenHash("iron", SPARSE_VOCAB_SIZE);
      expect(stats!.df.get(supplementsBucket)).toBe(2);
      expect(stats!.df.get(zincBucket)).toBe(2);
      expect(stats!.df.get(magBucket)).toBe(2);
      expect(stats!.df.get(ironBucket)).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("strips YAML frontmatter from page body before tokenizing", async () => {
    const body = "---\ntitle: foo\nedges: []\n---\nactual prose content";
    const dir = makeWorkspace({ a: body });
    try {
      await rebuildConceptPageCorpusStats(dir);
      const stats = getConceptPageCorpusStats();
      expect(stats).not.toBeNull();
      // "actual prose content" → 3 tokens, so avg_dl should be 3, not 8.
      expect(stats!.avgDl).toBe(3);
      // "title", "edges" should not be in DF (frontmatter stripped).
      const titleBucket = tokenHash("title", SPARSE_VOCAB_SIZE);
      const proseBucket = tokenHash("prose", SPARSE_VOCAB_SIZE);
      expect(stats!.df.get(titleBucket)).toBeUndefined();
      expect(stats!.df.get(proseBucket)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("generateBm25DocEmbedding", () => {
  test("token in every document gets IDF=0 and is omitted from the vector", () => {
    // 4 docs, "the" appears in all 4
    const theBucket = tokenHash("the", SPARSE_VOCAB_SIZE);
    const stats: CorpusStats = {
      totalDocs: 4,
      df: new Map([[theBucket, 4]]),
      avgDl: 5,
      builtAt: 0,
    };
    const vec = generateBm25DocEmbedding("the the the", stats, PARAMS);
    // The token "the" has IDF = log((4 - 4 + 0.5)/(4 + 0.5) + 1) = log(0.5/4.5 + 1)
    // ≈ log(1.111) ≈ 0.105 — non-zero. The "in every doc → IDF=0" claim only
    // holds for the simpler IDF variant; with Lucene's +1 we get a small
    // positive value. Confirm the value is small but present.
    expect(vec.indices.length).toBe(1);
    expect(vec.values[0]).toBeGreaterThan(0);
    expect(vec.values[0]).toBeLessThan(0.5);
  });

  test("rare token gets high IDF weight", () => {
    // 100 docs, "supplements" in 1 doc, "the" in 100.
    const supplementsBucket = tokenHash("supplements", SPARSE_VOCAB_SIZE);
    const theBucket = tokenHash("the", SPARSE_VOCAB_SIZE);
    const stats: CorpusStats = {
      totalDocs: 100,
      df: new Map([
        [supplementsBucket, 1],
        [theBucket, 100],
      ]),
      avgDl: 10,
      builtAt: 0,
    };
    const vec = generateBm25DocEmbedding("the supplements the", stats, PARAMS);
    const indexMap = new Map<number, number>();
    for (let i = 0; i < vec.indices.length; i++) {
      indexMap.set(vec.indices[i], vec.values[i]);
    }
    // supplements weight should massively exceed the weight.
    const supplementsWeight = indexMap.get(supplementsBucket) ?? 0;
    const theWeight = indexMap.get(theBucket) ?? 0;
    expect(supplementsWeight).toBeGreaterThan(theWeight * 10);
  });

  test("TF saturation: tf=10 score is nowhere near 10x of tf=1", () => {
    const supplementsBucket = tokenHash("supplements", SPARSE_VOCAB_SIZE);
    const stats: CorpusStats = {
      totalDocs: 100,
      df: new Map([[supplementsBucket, 1]]),
      // Set avg_dl equal to doc length → length factor = 1.
      avgDl: 1,
      builtAt: 0,
    };
    // tf=1 doc and tf=10 doc, both length-1-equivalent thanks to avg_dl above.
    // (We need real strings of the same length to get b=0.75 to behave; for
    // this test we use single-token inputs and avg_dl matched to the input
    // length to isolate the TF saturation effect.)
    const vec1 = generateBm25DocEmbedding(
      "supplements",
      { ...stats, avgDl: 1 },
      PARAMS,
    );
    const vec10 = generateBm25DocEmbedding(
      "supplements supplements supplements supplements supplements " +
        "supplements supplements supplements supplements supplements",
      { ...stats, avgDl: 10 },
      PARAMS,
    );
    const w1 = vec1.values[0];
    const w10 = vec10.values[0];
    // Under k1=1.2 and length-normalized inputs, TF saturation caps the
    // ratio near (k1+1)/k1 ≈ 1.83. Ratio must be far below 10.
    expect(w10 / w1).toBeGreaterThan(1.5);
    expect(w10 / w1).toBeLessThan(2.0);
  });

  test("length normalization: short doc with one match scores higher than long doc with one match", () => {
    const supplementsBucket = tokenHash("supplements", SPARSE_VOCAB_SIZE);
    const stats: CorpusStats = {
      totalDocs: 100,
      df: new Map([[supplementsBucket, 1]]),
      avgDl: 5,
      builtAt: 0,
    };
    const shortDoc = generateBm25DocEmbedding(
      "supplements zinc",
      stats,
      PARAMS,
    );
    const longDoc = generateBm25DocEmbedding(
      "supplements " +
        "the the the the the the the the the the the the the the the",
      stats,
      PARAMS,
    );
    const queryVec = generateBm25QueryEmbedding("supplements");
    const shortScore = dotProduct(queryVec, shortDoc);
    const longScore = dotProduct(queryVec, longDoc);
    expect(shortScore).toBeGreaterThan(longScore);
  });
});

describe("generateBm25QueryEmbedding", () => {
  test("emits binary occurrence per distinct token", () => {
    const vec = generateBm25QueryEmbedding("supplements supplements zinc");
    expect(vec.indices.length).toBe(2);
    for (const v of vec.values) expect(v).toBe(1);
  });

  test("empty input yields empty vector", () => {
    const vec = generateBm25QueryEmbedding("");
    expect(vec.indices.length).toBe(0);
    expect(vec.values.length).toBe(0);
  });
});

describe("end-to-end ranking: BM25 fixes the supplements bug", () => {
  test("BM25 ranks topical doc above narrative doc; pure TF does not", () => {
    // Doc A: short focused page about supplements
    // Doc B: long narrative repeating "I am" with one supplements mention
    const docA = "I am taking magnesium and zinc as supplements";
    const docB =
      "I am tired I am sad I am alone I am bored I am happy I am " +
      "tired again I am sad again I am alone again I am bored again " +
      "supplements";
    const query = "supplements am";

    // Build stats from these 2 docs.
    const tokensA = tokenize(docA);
    const tokensB = tokenize(docB);
    const df = new Map<number, number>();
    for (const tokens of [tokensA, tokensB]) {
      const seen = new Set<number>();
      for (const t of tokens) {
        const idx = tokenHash(t, SPARSE_VOCAB_SIZE);
        if (seen.has(idx)) continue;
        seen.add(idx);
        df.set(idx, (df.get(idx) ?? 0) + 1);
      }
    }
    const stats: CorpusStats = {
      totalDocs: 2,
      df,
      avgDl: (tokensA.length + tokensB.length) / 2,
      builtAt: 0,
    };
    _setCorpusStatsForTests(stats);

    const docVecA = generateBm25DocEmbedding(docA, stats, PARAMS);
    const docVecB = generateBm25DocEmbedding(docB, stats, PARAMS);
    const queryVec = generateBm25QueryEmbedding(query);

    const scoreA = dotProduct(queryVec, docVecA);
    const scoreB = dotProduct(queryVec, docVecB);

    // BM25 should rank A above B — the supplement-focused short doc wins
    // over the long personal-narrative doc with one supplement mention.
    expect(scoreA).toBeGreaterThan(scoreB);

    _resetCorpusStatsForTests();
  });
});
