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

export interface VariationHint {
  dimension: string;
  values: string[];
}

export interface ParsedAmazonProduct {
  asin?: string;
  title?: string;
  priceText?: string;
  priceValue?: number;
  prime: boolean;
  freshHint: boolean;
  variationHints: VariationHint[];
  warnings: string[];
}

export interface AmazonProductParseInput {
  text?: string;
  links?: string[];
  extracted?: {
    text?: string;
    links?: string[];
  };
}

const DIMENSION_LABELS = [
  "size",
  "color",
  "style",
  "flavor",
  "pack",
  "quantity",
  "scent",
  "material",
  "capacity",
  "pattern",
];

function isCandidateTitle(line: string): boolean {
  const lower = line.toLowerCase();
  if (line.length < 12) return false;
  if (line.includes("$")) return false;
  if (lower.includes("visit the") || lower.includes("store")) return false;
  if (lower.includes("delivery") || lower.includes("returns")) return false;
  if (lower.includes("customer reviews") || lower.includes("ratings"))
    return false;
  return true;
}

function parseVariationHints(lines: string[]): VariationHint[] {
  const hints: VariationHint[] = [];

  for (const line of lines) {
    const directMatch = line.match(
      /^(size|color|style|flavor|pack|quantity|scent|material|capacity|pattern)\s*[:\-]\s*(.+)$/i,
    );
    if (directMatch) {
      const values = directMatch[2]
        .split(/[\/,;|]/)
        .map((value) => normalizeWhitespace(value))
        .filter((value) => value.length > 0)
        .slice(0, 8);

      hints.push({
        dimension: directMatch[1].toLowerCase(),
        values,
      });
      continue;
    }

    const chooseMatch = line.match(
      /choose\s+(?:a|an)?\s*(size|color|style|flavor|pack|quantity|scent|material|capacity|pattern)/i,
    );
    if (chooseMatch) {
      hints.push({
        dimension: chooseMatch[1].toLowerCase(),
        values: [],
      });
    }
  }

  const merged = new Map<string, Set<string>>();
  for (const hint of hints) {
    const current = merged.get(hint.dimension) ?? new Set<string>();
    for (const value of hint.values) {
      current.add(value);
    }
    merged.set(hint.dimension, current);
  }

  return Array.from(merged.entries()).map(([dimension, values]) => ({
    dimension,
    values: Array.from(values),
  }));
}

export function parseAmazonProduct(
  input: AmazonProductParseInput,
): ParsedAmazonProduct {
  const text = input.text ?? input.extracted?.text ?? "";
  const links = safeArrayOfStrings(input.links ?? input.extracted?.links ?? []);
  const lines = toLines(text);
  const warnings: string[] = [];

  const asin = extractAsins(text)[0] ?? extractAsinsFromLinks(links)[0];
  if (!asin)
    warnings.push("No ASIN-like token found in extracted product content.");

  let title = lines.find((line) => isCandidateTitle(line));
  if (!title) warnings.push("Could not confidently identify a product title.");

  const firstPriceLine = lines.find((line) => parsePrice(line) !== null);
  const priceValue = firstPriceLine
    ? (parsePrice(firstPriceLine) ?? undefined)
    : undefined;
  const priceTextMatch = firstPriceLine?.match(
    /\$\s*[0-9][0-9,]*(?:\.[0-9]{2})?/,
  );
  const priceText = priceTextMatch
    ? normalizeWhitespace(priceTextMatch[0])
    : undefined;

  if (!priceText) warnings.push("No price found on product page extract.");

  const joined = lines.join(" ").toLowerCase();
  const prime = joined.includes("prime");
  const freshHint = joined.includes("fresh");

  const variationHints = parseVariationHints(lines);

  if (
    variationHints.length === 0 &&
    DIMENSION_LABELS.some((label) => joined.includes(label))
  ) {
    warnings.push(
      "Potential variant dimensions detected, but no structured options were parsed.",
    );
  }

  return {
    asin,
    title,
    priceText,
    priceValue,
    prime,
    freshHint,
    variationHints,
    warnings,
  };
}

async function main(): Promise<void> {
  try {
    const { args, payload } = await parseCliInput<AmazonProductParseInput>(
      process.argv.slice(2),
      {},
    );

    const text =
      (typeof args.text === "string" ? args.text : undefined) ?? payload.text;

    const links =
      (typeof args.links === "string"
        ? args.links
            .split(",")
            .map((item) => item.trim())
            .filter((item) => item.length > 0)
        : payload.links) ?? [];

    const data = parseAmazonProduct({
      ...payload,
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
