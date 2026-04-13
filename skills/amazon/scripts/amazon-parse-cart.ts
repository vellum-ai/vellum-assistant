#!/usr/bin/env bun

import {
  normalizeWhitespace,
  parseCliInput,
  parsePrice,
  printError,
  printJson,
  toLines,
} from "./lib/common.js";

export interface ParsedCartItem {
  title: string;
  quantity: number;
  priceText?: string;
  priceValue?: number;
}

export interface ParsedCartSummary {
  items: ParsedCartItem[];
  subtotal?: string;
  shipping?: string;
  tax?: string;
  total?: string;
  itemCount?: number;
  warnings: string[];
}

export interface AmazonCartParseInput {
  text?: string;
  extracted?: {
    text?: string;
  };
}

function extractMoneyLine(label: string, text: string): string | undefined {
  const regex = new RegExp(
    `${label}[^\\n$]*?(\\$\\s*[0-9][0-9,]*(?:\\.[0-9]{2})?)`,
    "i",
  );
  const match = text.match(regex);
  return match ? normalizeWhitespace(match[1]) : undefined;
}

function parseItemCount(text: string): number | undefined {
  const subtotalMatch = text.match(/subtotal\s*\((\d+)\s*items?\)/i);
  if (subtotalMatch) {
    const count = Number.parseInt(subtotalMatch[1], 10);
    if (Number.isFinite(count)) return count;
  }
  return undefined;
}

function parseQuantityAround(lines: string[], index: number): number {
  const window = lines.slice(
    Math.max(0, index - 1),
    Math.min(lines.length, index + 2),
  );
  for (const line of window) {
    const quantityMatch =
      line.match(/qty\s*[:x]?\s*(\d+)/i) ??
      line.match(/quantity\s*[:x]?\s*(\d+)/i);
    if (!quantityMatch) continue;
    const quantity = Number.parseInt(quantityMatch[1], 10);
    if (Number.isFinite(quantity) && quantity > 0) return quantity;
  }
  return 1;
}

function likelyItemTitle(line: string): boolean {
  const lower = line.toLowerCase();
  if (line.length < 8) return false;
  if (line.includes("$")) return false;
  if (
    lower.includes("subtotal") ||
    lower.includes("shipping") ||
    lower.includes("tax")
  )
    return false;
  if (lower.includes("save for later") || lower.includes("delete"))
    return false;
  if (
    lower.includes("proceed to checkout") ||
    lower.includes("place your order")
  )
    return false;
  return true;
}

export function parseAmazonCartSummary(
  input: AmazonCartParseInput,
): ParsedCartSummary {
  const text = input.text ?? input.extracted?.text ?? "";
  const normalizedText = normalizeWhitespace(text);
  const lines = toLines(text);

  const items: ParsedCartItem[] = [];
  const warnings: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const priceValue = parsePrice(line);
    if (priceValue === null) continue;

    const lower = line.toLowerCase();
    if (
      lower.includes("subtotal") ||
      lower.includes("shipping") ||
      lower.includes("tax") ||
      lower.includes("order total") ||
      lower.includes("total")
    ) {
      continue;
    }

    const title = [lines[index - 1], lines[index - 2]]
      .filter((candidate): candidate is string => typeof candidate === "string")
      .find((candidate) => likelyItemTitle(candidate));

    if (!title) continue;

    const priceTextMatch = line.match(/\$\s*[0-9][0-9,]*(?:\.[0-9]{2})?/);
    items.push({
      title,
      quantity: parseQuantityAround(lines, index),
      priceText: priceTextMatch
        ? normalizeWhitespace(priceTextMatch[0])
        : undefined,
      priceValue,
    });
  }

  const deduped = new Map<string, ParsedCartItem>();
  for (const item of items) {
    const key = item.title.toLowerCase();
    if (!deduped.has(key)) {
      deduped.set(key, item);
    }
  }

  const outputItems = Array.from(deduped.values());

  const subtotal = extractMoneyLine(
    "(?:item\\(s\\)\\s*)?subtotal",
    normalizedText,
  );
  const shipping = extractMoneyLine("shipping", normalizedText);
  const tax = extractMoneyLine("(?:estimated\\s*)?tax", normalizedText);
  const total =
    extractMoneyLine("order\\s*total", normalizedText) ??
    extractMoneyLine("total", normalizedText);

  const itemCount = parseItemCount(normalizedText) ?? outputItems.length;

  if (!subtotal) warnings.push("Subtotal was not detected in cart extract.");
  if (!total) warnings.push("Order total was not detected in cart extract.");
  if (outputItems.length === 0)
    warnings.push("No cart line items were confidently parsed.");

  return {
    items: outputItems,
    subtotal,
    shipping,
    tax,
    total,
    itemCount,
    warnings,
  };
}

async function main(): Promise<void> {
  try {
    const { args, payload } = await parseCliInput<AmazonCartParseInput>(
      process.argv.slice(2),
      {},
    );

    const text =
      (typeof args.text === "string" ? args.text : undefined) ?? payload.text;

    const data = parseAmazonCartSummary({
      ...payload,
      text,
    });

    printJson({ ok: true, data });
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
  }
}

if (import.meta.main) {
  await main();
}
