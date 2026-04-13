#!/usr/bin/env bun

import {
  extractAsins,
  extractAsinsFromLinks,
  normalizeWhitespace,
  parseCliInput,
  parsePrice,
  printError,
  printJson,
  safeArrayOfStrings,
  toLines,
} from "./lib/common.js";

export interface AmazonSearchCandidate {
  asin?: string;
  title: string;
  priceText?: string;
  priceValue?: number;
  prime: boolean;
  freshHint: boolean;
  score: number;
}

export interface AmazonSearchParseInput {
  query?: string;
  text?: string;
  links?: string[];
  extracted?: {
    text?: string;
    links?: string[];
  };
}

function termOverlapScore(query: string, title: string): number {
  const queryTerms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 1);
  if (queryTerms.length === 0) return 0;

  const titleLower = title.toLowerCase();
  const hits = queryTerms.filter((term) => titleLower.includes(term)).length;
  return hits / queryTerms.length;
}

function isLikelyTitle(line: string): boolean {
  const lower = line.toLowerCase();
  if (lower.length < 8) return false;
  if (/^[a-z0-9]{10}$/i.test(line)) return false;
  if (lower.includes("results") || lower.includes("sort by")) return false;
  if (lower.includes("delivery") || lower.includes("sponsored")) return false;
  if (lower.includes("customer reviews") || lower.includes("stars"))
    return false;
  if (line.includes("$")) return false;
  return true;
}

function firstPriceInWindow(
  lines: string[],
  index: number,
): { text: string; value: number } | null {
  const start = Math.max(0, index - 2);
  const end = Math.min(lines.length - 1, index + 3);
  for (let i = start; i <= end; i += 1) {
    const value = parsePrice(lines[i]);
    if (value === null) continue;
    const match = lines[i].match(/\$\s*[0-9][0-9,]*(?:\.[0-9]{2})?/);
    if (!match) continue;
    return { text: normalizeWhitespace(match[0]), value };
  }
  return null;
}

function nearestTitle(lines: string[], index: number): string | null {
  const window = [0, -1, 1, -2, 2, -3, 3];
  for (const delta of window) {
    const idx = index + delta;
    if (idx < 0 || idx >= lines.length) continue;
    if (!isLikelyTitle(lines[idx])) continue;
    return lines[idx];
  }
  return null;
}

export function parseAmazonSearchCandidates(
  input: AmazonSearchParseInput,
): AmazonSearchCandidate[] {
  const query = normalizeWhitespace(input.query ?? "");
  const text = input.text ?? input.extracted?.text ?? "";
  const links = safeArrayOfStrings(input.links ?? input.extracted?.links ?? []);
  const lines = toLines(text);

  const asinByLine: Array<{ asin: string; lineIndex: number }> = [];
  lines.forEach((line, index) => {
    for (const asin of extractAsins(line)) {
      asinByLine.push({ asin, lineIndex: index });
    }
  });

  const linkAsins = extractAsinsFromLinks(links);
  for (const asin of linkAsins) {
    asinByLine.push({ asin, lineIndex: 0 });
  }

  const candidates: AmazonSearchCandidate[] = [];

  for (const { asin, lineIndex } of asinByLine) {
    const title = nearestTitle(lines, lineIndex);
    if (!title) continue;

    const price = firstPriceInWindow(lines, lineIndex);
    const neighborhood = lines
      .slice(Math.max(0, lineIndex - 2), Math.min(lines.length, lineIndex + 3))
      .join(" ")
      .toLowerCase();

    let score = termOverlapScore(query, title);
    if (price) score += 0.15;
    if (neighborhood.includes("prime")) score += 0.1;
    if (neighborhood.includes("fresh")) score += 0.08;

    candidates.push({
      asin,
      title,
      priceText: price?.text,
      priceValue: price?.value,
      prime: neighborhood.includes("prime"),
      freshHint: neighborhood.includes("fresh"),
      score,
    });
  }

  if (candidates.length === 0) {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!isLikelyTitle(line)) continue;
      const price = firstPriceInWindow(lines, i);
      if (!price) continue;

      let score = termOverlapScore(query, line) + 0.1;
      const neighborhood = lines
        .slice(Math.max(0, i - 2), Math.min(lines.length, i + 3))
        .join(" ")
        .toLowerCase();

      if (neighborhood.includes("prime")) score += 0.1;
      if (neighborhood.includes("fresh")) score += 0.08;

      candidates.push({
        title: line,
        priceText: price.text,
        priceValue: price.value,
        prime: neighborhood.includes("prime"),
        freshHint: neighborhood.includes("fresh"),
        score,
      });
    }
  }

  const byKey = new Map<string, AmazonSearchCandidate>();
  for (const candidate of candidates) {
    const key = candidate.asin ?? candidate.title.toLowerCase();
    const existing = byKey.get(key);
    if (!existing || candidate.score > existing.score) {
      byKey.set(key, candidate);
    }
  }

  return Array.from(byKey.values())
    .sort((left, right) => right.score - left.score)
    .slice(0, 20);
}

async function main(): Promise<void> {
  try {
    const { args, payload } = await parseCliInput<AmazonSearchParseInput>(
      process.argv.slice(2),
      {},
    );

    const query =
      (typeof args.query === "string" ? args.query : undefined) ??
      payload.query;

    const text =
      (typeof args.text === "string" ? args.text : undefined) ?? payload.text;

    const links =
      (typeof args.links === "string"
        ? args.links
            .split(",")
            .map((item) => item.trim())
            .filter((item) => item.length > 0)
        : payload.links) ?? [];

    const data = parseAmazonSearchCandidates({
      ...payload,
      query,
      text,
      links,
    });

    printJson({ ok: true, data });
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
  }
}

if (import.meta.main) {
  await main();
}
