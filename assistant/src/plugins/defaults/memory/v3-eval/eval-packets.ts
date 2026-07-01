/**
 * Memory-v3 corpus eval: build blinded A/B judge packets comparing retrieval
 * over two on-disk concept corpora (e.g. a pre-migration v2 snapshot vs a staged
 * v3 wiki) on the same mined historical turns.
 *
 * The two corpora are a pure reorganization of the same knowledge (the staged
 * wiki is authored FROM the snapshot), so the comparison measures retrieval
 * *shape*, not knowledge — no per-turn time-gating is needed: both sides hold
 * the same information, so a page encoding post-turn knowledge is reachable in
 * both and cannot bias one side. The blind judge (a separate workflow) scores
 * each packet on coverage; this module only produces the packets.
 *
 * Retrieval mirrors the live section-lane engine's cheap lanes: a BM25F needle
 * over sections, optionally unioned with dense cosine over section embeddings.
 * Everything runs in memory — no Qdrant writes, no live-lane mutation — which is
 * why it is safe to run against arbitrary staging/snapshot directories.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";

import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";

import type { AssistantConfig } from "../../../../config/types.js";
import type { getDb } from "../../../../persistence/db-connection.js";
import { embedWithRetry } from "../../../../persistence/embeddings/embed.js";
import { stringifyMessageContent } from "../../../../persistence/message-content.js";
import {
  conversations,
  messages,
} from "../../../../persistence/schema/index.js";
import { FRONTMATTER_REGEX, parseFrontmatterFields } from "../frontmatter.js";
import { injectedConceptHeader } from "../v2/injected-block-slugs.js";
import { slugFromConceptPath } from "../v2/page-store.js";
import { renderCard } from "../v3/card.js";
import { buildSectionNeedle } from "../v3/section-needle.js";
import { buildSectionIndex } from "../v3/sections.js";
import type { SectionIndex, Slug } from "../v3/types.js";

type DrizzleDb = ReturnType<typeof getDb>;

/** A text-embedding function returning one vector per input, in order. */
export type EmbedAll = (texts: string[]) => Promise<number[][]>;

// ---------------------------------------------------------------------------
// Corpus loading (arbitrary directory of `.md` concept pages)
// ---------------------------------------------------------------------------

export interface Corpus {
  /** Flat slugs (path under `dir`, minus `.md`, forward-slashed). */
  slugs: Slug[];
  /** slug -> full file text (frontmatter included; the card renderer strips it). */
  rawBySlug: Map<Slug, string>;
  /** slug -> frontmatter-stripped body (what the section index chunks). */
  bodyBySlug: Map<Slug, string>;
}

/** Read every `.md` page under `dir` into a {@link Corpus}. */
export function loadCorpus(dir: string): Corpus {
  if (!existsSync(dir)) {
    throw new Error(`corpus directory does not exist: ${dir}`);
  }
  const slugs: Slug[] = [];
  const rawBySlug = new Map<Slug, string>();
  const bodyBySlug = new Map<Slug, string>();

  for (const rel of readdirSync(dir, { recursive: true })) {
    const relPath = typeof rel === "string" ? rel : String(rel);
    if (!relPath.endsWith(".md")) continue;
    const full = join(dir, relPath);
    const raw = readFileSync(full, "utf8");
    const slug = slugFromConceptPath(dir, full);
    const parsed = parseFrontmatterFields(raw);
    const body = parsed ? parsed.body : raw.replace(FRONTMATTER_REGEX, "");
    slugs.push(slug);
    rawBySlug.set(slug, raw);
    bodyBySlug.set(slug, body);
  }
  return { slugs, rawBySlug, bodyBySlug };
}

// ---------------------------------------------------------------------------
// Vector helpers
// ---------------------------------------------------------------------------

function normalize(v: number[]): number[] {
  let sumSq = 0;
  for (const x of v) sumSq += x * x;
  const norm = Math.sqrt(sumSq) || 1;
  return v.map((x) => x / norm);
}

/** Dot product; on unit-normalized vectors this is cosine similarity. */
export function dot(a: number[], b: number[]): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) sum += a[i]! * b[i]!;
  return sum;
}

// ---------------------------------------------------------------------------
// Retriever (needle ∪ dense, in memory)
// ---------------------------------------------------------------------------

export interface RetrievalHit {
  slug: Slug;
  /** Index into `SectionIndex.sections` of the matched section. */
  sectionIdx: number;
}

export interface Retriever {
  index: SectionIndex;
  rawBySlug: Map<Slug, string>;
  /** Top-`k` distinct articles (needle ∪ dense), each with a matched section. */
  retrieve(
    queryText: string,
    queryVec: number[] | null,
    k: number,
  ): RetrievalHit[];
}

/**
 * Build a retriever over a corpus. When `dense` is true, every section is
 * embedded (via `embedAll`) and stored unit-normalized for cosine search.
 */
export async function buildRetriever(
  corpus: Corpus,
  embedAll: EmbedAll,
  dense: boolean,
): Promise<Retriever> {
  const index = await buildSectionIndex(
    corpus.slugs,
    async (slug) => corpus.bodyBySlug.get(slug) ?? "",
  );
  const needle = buildSectionNeedle(index);

  let sectionVecs: number[][] | null = null;
  if (dense && index.sections.length > 0) {
    const raw = await embedAll(index.sections.map((s) => s.text));
    sectionVecs = raw.map(normalize);
  }

  function denseHits(queryVec: number[], k: number): RetrievalHit[] {
    if (!sectionVecs) return [];
    const scored = sectionVecs.map((sv, i) => ({
      i,
      score: dot(queryVec, sv),
    }));
    scored.sort((a, b) => b.score - a.score || a.i - b.i);
    const seen = new Set<Slug>();
    const hits: RetrievalHit[] = [];
    for (const { i } of scored) {
      const slug = index.sections[i]!.article;
      if (seen.has(slug)) continue;
      seen.add(slug);
      hits.push({ slug, sectionIdx: i });
      if (hits.length >= k) break;
    }
    return hits;
  }

  function retrieve(
    queryText: string,
    queryVec: number[] | null,
    k: number,
  ): RetrievalHit[] {
    const lexical: RetrievalHit[] = needle
      .query(queryText, k)
      .map((h) => ({ slug: h.article, sectionIdx: h.section }));
    const semantic = queryVec ? denseHits(queryVec, k) : [];

    // Round-robin interleave the two lanes so neither dominates, dedupe by
    // article, keep the section from whichever lane surfaced it first.
    const merged: RetrievalHit[] = [];
    const seen = new Set<Slug>();
    for (let i = 0; i < Math.max(lexical.length, semantic.length); i++) {
      for (const hit of [lexical[i], semantic[i]]) {
        if (!hit || seen.has(hit.slug)) continue;
        seen.add(hit.slug);
        merged.push(hit);
        if (merged.length >= k) return merged;
      }
    }
    return merged;
  }

  return { index, rawBySlug: corpus.rawBySlug, retrieve };
}

/**
 * Render the retrieved pages as one "memory set" string: each page's live-style
 * card (lead + section TOC) followed by its matched section in full, mirroring
 * what the model sees (accumulated cards + spotlighted section).
 */
export function renderMemorySet(
  retriever: Retriever,
  hits: RetrievalHit[],
  sectionCharCap: number,
): string {
  if (hits.length === 0) return "(no pages retrieved)";
  const parts: string[] = [];
  for (const hit of hits) {
    const raw = retriever.rawBySlug.get(hit.slug) ?? "";
    const card = renderCard(hit.slug, raw);
    const section = retriever.index.sections[hit.sectionIdx];
    if (section) {
      const body = section.text.trim().slice(0, sectionCharCap);
      parts.push(`${card}\n\n${injectedConceptHeader(hit.slug)}\n${body}`);
    } else {
      parts.push(card);
    }
  }
  return parts.join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Turn mining
// ---------------------------------------------------------------------------

export interface RawMsgRow {
  conversationId: string;
  id: string;
  role: string;
  content: string;
  createdAt: number;
}

export interface MinedTurn {
  /** Stable id: `${conversationId}:${createdAt}`. */
  turn: string;
  conversationId: string;
  userText: string;
  replyText: string;
  /** The preceding reply in the same conversation (truncated), or "". */
  context: string;
  createdAt: number;
}

/**
 * Pair each user message with the next assistant reply in the same conversation,
 * cap per conversation, and keep the most recent `limit` turns. Pure over `rows`
 * (which must be chronological per conversation) so it is unit-testable.
 */
export function pairTurns(
  rows: RawMsgRow[],
  opts: { limit: number; perConversationCap: number; contextCharCap?: number },
): MinedTurn[] {
  const contextCap = opts.contextCharCap ?? 600;
  const byConversation: MinedTurn[][] = [];
  const indexOfConversation = new Map<string, number>();

  let pendingUser: RawMsgRow | null = null;
  let lastReply = "";
  let currentConversation = "";

  for (const m of rows) {
    if (m.conversationId !== currentConversation) {
      currentConversation = m.conversationId;
      pendingUser = null;
      lastReply = "";
    }
    if (m.role === "user") {
      pendingUser = m;
    } else if (m.role === "assistant" && pendingUser) {
      const userText = stringifyMessageContent(pendingUser.content);
      const replyText = stringifyMessageContent(m.content);
      if (userText.length > 0 && replyText.length >= 40) {
        let bucket = indexOfConversation.get(m.conversationId);
        if (bucket === undefined) {
          bucket = byConversation.length;
          indexOfConversation.set(m.conversationId, bucket);
          byConversation.push([]);
        }
        byConversation[bucket]!.push({
          turn: `${m.conversationId}:${pendingUser.createdAt}`,
          conversationId: m.conversationId,
          userText,
          replyText,
          context: lastReply.slice(0, contextCap),
          createdAt: pendingUser.createdAt,
        });
      }
      lastReply = replyText;
      pendingUser = null;
    }
  }

  // Cap per conversation (keep the most recent within each), then globally rank
  // by recency and take `limit`.
  const capped: MinedTurn[] = [];
  for (const turns of byConversation) {
    capped.push(...turns.slice(-opts.perConversationCap));
  }
  capped.sort((a, b) => b.createdAt - a.createdAt);
  return capped.slice(0, opts.limit);
}

/** The conversation id embedded in a `${conversationId}:${createdAt}` turn id. */
export function turnConversationId(turnId: string): string {
  return turnId.slice(0, turnId.lastIndexOf(":"));
}

/**
 * Keep exactly the pinned turn ids, in pinned order. Turns that no longer exist
 * (deleted since the ids were captured) are dropped — the caller compares the
 * returned count to the requested count to surface drops. Pure over `allTurns`
 * so it is unit-testable.
 */
export function selectPinnedTurns(
  allTurns: MinedTurn[],
  pinnedTurnIds: string[],
): MinedTurn[] {
  const byId = new Map(allTurns.map((t) => [t.turn, t]));
  const out: MinedTurn[] = [];
  for (const id of pinnedTurnIds) {
    const t = byId.get(id);
    if (t) out.push(t);
  }
  return out;
}

/** Group by conversation, ascending by time, so `pairTurns` walks each in order. */
function sortForPairing(rows: RawMsgRow[]): RawMsgRow[] {
  return [...rows].sort(
    (a, b) =>
      a.conversationId.localeCompare(b.conversationId) ||
      a.createdAt - b.createdAt ||
      a.id.localeCompare(b.id),
  );
}

/**
 * Read user→assistant turns from the live DB (read-only).
 *
 * Default: the most recent `limit` turns by recency, optionally omitting given
 * conversations — e.g. the migration's own chat, which would otherwise let the
 * eval judge turns from the very conversation driving the migration. With
 * `pinnedTurnIds`, instead re-mine EXACTLY those turns (scoped to their
 * conversations, no recency window) so a re-run measures the same turn set as a
 * prior run — the eval is only reproducible if the turns are held fixed while
 * the staged corpus changes.
 */
export function mineTurns(
  db: DrizzleDb,
  opts: {
    limit: number;
    perConversationCap: number;
    maxScan?: number;
    pinnedTurnIds?: string[];
    excludeConversationIds?: string[];
  },
): MinedTurn[] {
  if (opts.pinnedTurnIds && opts.pinnedTurnIds.length > 0) {
    return minePinnedTurns(db, opts.pinnedTurnIds);
  }

  const maxScan = opts.maxScan ?? 6000;
  const exclude = opts.excludeConversationIds ?? [];
  const recent = db
    .select({
      conversationId: messages.conversationId,
      id: messages.id,
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(
      and(
        sql`COALESCE(${conversations.source}, 'user') = 'user'`,
        sql`${conversations.scheduleJobId} IS NULL`,
        ...(exclude.length > 0
          ? [notInArray(messages.conversationId, exclude)]
          : []),
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(maxScan)
    .all() as RawMsgRow[];

  return pairTurns(sortForPairing(recent), opts);
}

/** Re-mine exactly the pinned turns from their conversations (no recency cap). */
function minePinnedTurns(db: DrizzleDb, pinnedTurnIds: string[]): MinedTurn[] {
  const conversationIds = [...new Set(pinnedTurnIds.map(turnConversationId))];
  const rows = db
    .select({
      conversationId: messages.conversationId,
      id: messages.id,
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(
      and(
        inArray(messages.conversationId, conversationIds),
        sql`COALESCE(${conversations.source}, 'user') = 'user'`,
        sql`${conversations.scheduleJobId} IS NULL`,
      ),
    )
    .all() as RawMsgRow[];

  const allTurns = pairTurns(sortForPairing(rows), {
    limit: Number.MAX_SAFE_INTEGER,
    perConversationCap: Number.MAX_SAFE_INTEGER,
  });
  return selectPinnedTurns(allTurns, pinnedTurnIds);
}

// ---------------------------------------------------------------------------
// Packet assembly (with seeded blinding)
// ---------------------------------------------------------------------------

export interface EvalPacket {
  turn: string;
  context: string;
  userMessage: string;
  reply: string;
  setA: string;
  setB: string;
}

export interface EvalKeyEntry {
  turn: string;
  a: "snapshot" | "staging";
  b: "snapshot" | "staging";
}

/** Deterministic PRNG so the A/B assignment is reproducible from a seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function buildPackets(
  turns: MinedTurn[],
  snapshot: Retriever,
  staging: Retriever,
  embedAll: EmbedAll,
  opts: { dense: boolean; seed: number; k: number; sectionCharCap: number },
): Promise<{ packets: EvalPacket[]; key: EvalKeyEntry[] }> {
  const queryVecs: (number[] | null)[] = opts.dense
    ? (await embedAll(turns.map((t) => t.userText))).map(normalize)
    : turns.map(() => null);

  const rng = mulberry32(opts.seed);
  const packets: EvalPacket[] = [];
  const key: EvalKeyEntry[] = [];

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]!;
    const qVec = queryVecs[i] ?? null;
    const snapSet = renderMemorySet(
      snapshot,
      snapshot.retrieve(t.userText, qVec, opts.k),
      opts.sectionCharCap,
    );
    const stageSet = renderMemorySet(
      staging,
      staging.retrieve(t.userText, qVec, opts.k),
      opts.sectionCharCap,
    );
    const stagingIsA = rng() < 0.5;
    packets.push({
      turn: t.turn,
      context: t.context,
      userMessage: t.userText,
      reply: t.replyText,
      setA: stagingIsA ? stageSet : snapSet,
      setB: stagingIsA ? snapSet : stageSet,
    });
    key.push({
      turn: t.turn,
      a: stagingIsA ? "staging" : "snapshot",
      b: stagingIsA ? "snapshot" : "staging",
    });
  }
  return { packets, key };
}

// ---------------------------------------------------------------------------
// Top-level run
// ---------------------------------------------------------------------------

export interface EvalParams {
  /** Staged v3 wiki dir (relative to workspace, or absolute). */
  stagingDir: string;
  /** Read-only v2 snapshot dir (relative to workspace, or absolute). */
  snapshotDir: string;
  /** Output dir for packets.json + key.json (relative to workspace, or absolute). */
  outDir: string;
  turns?: number;
  perConversationCap?: number;
  /** Pages per memory set. */
  k?: number;
  /** Include the dense lane (embeds both corpora). Off = needle-only, no embeds. */
  dense?: boolean;
  seed?: number;
  sectionCharCap?: number;
  /**
   * Pin the exact turns to mine (the `turn` ids from a prior run's key.json or
   * packets.json). Re-running with the same pinned set holds the comparison
   * fixed while the staged corpus changes — required for a reproducible re-judge.
   */
  turnIds?: string[];
  /**
   * Conversations to omit from the default (recency) mining — e.g. the
   * migration's own chat, so the eval does not judge turns from the very
   * conversation driving it. Ignored when `turnIds` is set.
   */
  excludeConversationIds?: string[];
}

/**
 * The embedding backend identity in effect for a run, recorded in eval-meta.json.
 * Dense retrieval is only comparable across runs with the SAME identity: a
 * mid-migration config change (e.g. a 384-dim local model to a 3072-dim hosted
 * one) silently re-embeds both corpora in a different vector space, so a re-run
 * that drifted here is measuring something different — exactly the kind of hidden
 * variable that made an eval gate look non-reproducible.
 */
export interface EmbeddingIdentity {
  provider: string;
  model: string;
  /** Observed embedding dimension (from the first vector); null when dense is off. */
  dims: number | null;
}

export interface EvalResult {
  turnsMined: number;
  /** Turns requested: the pinned count, or the recency `turns` limit. */
  turnsRequested: number;
  packetsWritten: number;
  packetsPath: string;
  keyPath: string;
  /** eval-meta.json: seed/k/dense/embedding identity + the resolved turn ids. */
  metaPath: string;
  snapshotPages: number;
  stagingPages: number;
  dense: boolean;
  seed: number;
  k: number;
  embedding: EmbeddingIdentity;
  /** The resolved turn ids actually packed — pass as `turnIds` to pin a re-run. */
  turnIds: string[];
}

export interface EvalDeps {
  config: AssistantConfig;
  workspaceDir: string;
  db: DrizzleDb;
  /** Embed one batch of texts. Defaults to the live embedding backend. */
  embed?: EmbedAll;
}

/** Human-readable identity of the configured embedding model (provider + model name). */
function describeEmbeddingModel(config: AssistantConfig): {
  provider: string;
  model: string;
} {
  const e = config.memory?.embeddings;
  const provider = e?.provider ?? "unknown";
  const model =
    provider === "gemini"
      ? e?.geminiModel
      : provider === "openai"
        ? e?.openaiModel
        : provider === "ollama"
          ? e?.ollamaModel
          : provider === "local"
            ? e?.localModel
            : provider; // "auto" / future providers: name == provider
  return { provider, model: model ?? provider };
}

/** Chunk an embed function so a large corpus never overruns provider batch limits. */
function chunkedEmbed(embed: EmbedAll, batchSize = 96): EmbedAll {
  return async (texts: string[]) => {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      out.push(...(await embed(texts.slice(i, i + batchSize))));
    }
    return out;
  };
}

/**
 * Resolve a corpus/output path against the workspace, rejecting anything that
 * escapes it. The route is in the shared table (HTTP + IPC), so an actor caller
 * could otherwise pass an absolute path to read/write arbitrary trees — these
 * dirs must stay under the workspace.
 */
export function resolveDir(workspaceDir: string, p: string): string {
  const root = resolve(workspaceDir);
  const resolved = resolve(root, p);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(`eval path must stay within the workspace: ${p}`);
  }
  return resolved;
}

/**
 * Run the full eval: load both corpora, mine turns, retrieve both sides, and
 * write blinded packets + the unblinding key. Returns counts.
 */
export async function runMemoryEval(
  params: EvalParams,
  deps: EvalDeps,
): Promise<EvalResult> {
  const dense = params.dense ?? true;
  const k = params.k ?? 8;
  const seed = params.seed ?? 1;
  const sectionCharCap = params.sectionCharCap ?? 1200;

  const snapshotDir = resolveDir(deps.workspaceDir, params.snapshotDir);
  const stagingDir = resolveDir(deps.workspaceDir, params.stagingDir);
  const outDir = resolveDir(deps.workspaceDir, params.outDir);

  const baseEmbed: EmbedAll =
    deps.embed ??
    (async (texts) => (await embedWithRetry(deps.config, texts)).vectors);
  // Capture the observed embedding dimension so eval-meta.json records the
  // vector space the dense lane actually ran in (drift detection across re-runs).
  let observedDims: number | null = null;
  const capturingEmbed: EmbedAll = async (texts) => {
    const vectors = await baseEmbed(texts);
    if (observedDims === null && vectors.length > 0 && vectors[0]) {
      observedDims = vectors[0].length;
    }
    return vectors;
  };
  const embedAll = chunkedEmbed(capturingEmbed);

  const snapshotCorpus = loadCorpus(snapshotDir);
  const stagingCorpus = loadCorpus(stagingDir);

  const snapshot = await buildRetriever(snapshotCorpus, embedAll, dense);
  const staging = await buildRetriever(stagingCorpus, embedAll, dense);

  const turnsRequested =
    params.turnIds && params.turnIds.length > 0
      ? params.turnIds.length
      : (params.turns ?? 30);
  const turns = mineTurns(deps.db, {
    limit: params.turns ?? 30,
    perConversationCap: params.perConversationCap ?? 4,
    ...(params.turnIds ? { pinnedTurnIds: params.turnIds } : {}),
    ...(params.excludeConversationIds
      ? { excludeConversationIds: params.excludeConversationIds }
      : {}),
  });

  const { packets, key } = await buildPackets(
    turns,
    snapshot,
    staging,
    embedAll,
    {
      dense,
      seed,
      k,
      sectionCharCap,
    },
  );

  const embedding: EmbeddingIdentity = {
    ...describeEmbeddingModel(deps.config),
    dims: dense ? observedDims : null,
  };
  const turnIds = packets.map((p) => p.turn);

  mkdirSync(outDir, { recursive: true });
  const packetsPath = join(outDir, "packets.json");
  const keyPath = join(outDir, "key.json");
  const metaPath = join(outDir, "eval-meta.json");
  writeFileSync(packetsPath, JSON.stringify(packets, null, 2));
  writeFileSync(keyPath, JSON.stringify(key, null, 2));
  writeFileSync(
    metaPath,
    JSON.stringify(
      {
        seed,
        k,
        dense,
        embedding,
        snapshotPages: snapshotCorpus.slugs.length,
        stagingPages: stagingCorpus.slugs.length,
        turnsRequested,
        turnsMined: turns.length,
        turnIds,
      },
      null,
      2,
    ),
  );

  return {
    turnsMined: turns.length,
    turnsRequested,
    packetsWritten: packets.length,
    packetsPath,
    keyPath,
    metaPath,
    snapshotPages: snapshotCorpus.slugs.length,
    stagingPages: stagingCorpus.slugs.length,
    dense,
    seed,
    k,
    embedding,
    turnIds,
  };
}
