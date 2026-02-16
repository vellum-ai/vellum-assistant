import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { getConfig } from '../config/loader.js';
import { estimateTextTokens } from '../context/token-estimator.js';
import { getDb } from './db.js';
import { memoryItems } from './schema.js';

const PROFILE_KIND_ALLOWLIST = ['profile', 'preference', 'constraint', 'instruction'] as const;

const TRUST_RANK: Record<string, number> = {
  user_confirmed: 3,
  user_reported: 2,
  assistant_inferred: 1,
};

export interface CompileProfileOptions {
  scopeId?: string;
  maxInjectTokensOverride?: number;
}

export interface CompiledProfile {
  text: string;
  sourceCount: number;
  selectedCount: number;
  budgetTokens: number;
  tokenEstimate: number;
}

interface ProfileCandidate {
  kind: string;
  subject: string;
  statement: string;
  verificationState: string;
  confidence: number;
  importance: number | null;
  lastSeenAt: number;
  firstSeenAt: number;
}

export function compileDynamicProfile(options?: CompileProfileOptions): CompiledProfile {
  const config = getConfig();
  const profileConfig = config.memory.profile;
  const scopeId = options?.scopeId ?? 'default';
  const budgetTokens = Math.max(0, Math.floor(options?.maxInjectTokensOverride ?? profileConfig.maxInjectTokens));
  if (!profileConfig.enabled || budgetTokens <= 0) {
    return { text: '', sourceCount: 0, selectedCount: 0, budgetTokens, tokenEstimate: 0 };
  }

  const db = getDb();
  const rows = db
    .select({
      kind: memoryItems.kind,
      subject: memoryItems.subject,
      statement: memoryItems.statement,
      verificationState: memoryItems.verificationState,
      confidence: memoryItems.confidence,
      importance: memoryItems.importance,
      lastSeenAt: memoryItems.lastSeenAt,
      firstSeenAt: memoryItems.firstSeenAt,
    })
    .from(memoryItems)
    .where(and(
      eq(memoryItems.scopeId, scopeId),
      eq(memoryItems.status, 'active'),
      isNull(memoryItems.invalidAt),
      inArray(memoryItems.kind, [...PROFILE_KIND_ALLOWLIST]),
    ))
    .orderBy(desc(memoryItems.lastSeenAt))
    .all();

  const nowMs = Date.now();
  const trusted = rows
    .filter((row) => TRUST_RANK[row.verificationState] !== undefined)
    .sort((a, b) => compareProfileCandidates(a, b, nowMs));

  const selectedLines: string[] = [];
  const seenKeys = new Set<string>();
  for (const candidate of trusted) {
    const subject = normalizeWhitespace(candidate.subject, 80);
    const statement = normalizeWhitespace(candidate.statement, 220);
    if (!subject || !statement) continue;
    const dedupeKey = `${candidate.kind}|${subject.toLowerCase()}`;
    if (seenKeys.has(dedupeKey)) continue;

    const line = `- ${subject}: ${statement}`;
    const tentative = renderProfileText([...selectedLines, line]);
    if (estimateTextTokens(tentative) > budgetTokens) continue;
    seenKeys.add(dedupeKey);
    selectedLines.push(line);
  }

  const text = renderProfileText(selectedLines);
  const tokenEstimate = text ? estimateTextTokens(text) : 0;
  return {
    text,
    sourceCount: trusted.length,
    selectedCount: selectedLines.length,
    budgetTokens,
    tokenEstimate,
  };
}

/** Half-life for recency decay — items seen this many ms ago score ~0.5. (30 days) */
const RECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

function recencyScore(lastSeenAt: number, nowMs: number): number {
  const ageMs = Math.max(0, nowMs - lastSeenAt);
  return Math.pow(0.5, ageMs / RECENCY_HALF_LIFE_MS);
}

function candidateRankScore(c: ProfileCandidate, nowMs: number): number {
  const importance = c.importance ?? 0.5;
  const recency = recencyScore(c.lastSeenAt, nowMs);
  // Use weighted additive formula: importance dominates, recency is a minor boost
  // This preserves high-importance items even when they haven't been seen recently
  return importance * 0.7 + recency * 0.3;
}

function compareProfileCandidates(left: ProfileCandidate, right: ProfileCandidate, nowMs: number): number {
  const trustDelta = (TRUST_RANK[right.verificationState] ?? 0) - (TRUST_RANK[left.verificationState] ?? 0);
  if (trustDelta !== 0) return trustDelta;

  const scoreDelta = candidateRankScore(right, nowMs) - candidateRankScore(left, nowMs);
  if (scoreDelta !== 0) return scoreDelta;

  const confidenceDelta = right.confidence - left.confidence;
  if (confidenceDelta !== 0) return confidenceDelta;

  return right.firstSeenAt - left.firstSeenAt;
}

function normalizeWhitespace(input: string, maxLength: number): string {
  return input.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function renderProfileText(lines: string[]): string {
  if (lines.length === 0) return '';
  return ['<dynamic-user-profile>', ...lines, '</dynamic-user-profile>'].join('\n');
}
