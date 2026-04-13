#!/usr/bin/env bun

import {
  type HelperEnvelope,
  parseCliInput,
  printError,
  printJson,
  toBool,
} from "./lib/common.js";

export type AmazonFlowStep =
  | "search"
  | "variant_select"
  | "cart_review"
  | "checkout_review"
  | "fresh_slot"
  | "place_order";

export interface AmazonIntentContext {
  cartConfirmed?: boolean;
  checkoutReviewed?: boolean;
  freshSlotSelected?: boolean;
  hasCartItems?: boolean;
}

export interface AmazonIntentInput extends HelperEnvelope<AmazonIntentContext> {
  request?: string;
}

export interface AmazonIntentResult {
  step: AmazonFlowStep;
  confidence: number;
  reasons: string[];
  needsExplicitConfirmation: boolean;
  suggestedNextAction: string;
}

function includesAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term));
}

export function classifyAmazonIntent(
  input: AmazonIntentInput,
): AmazonIntentResult {
  const context = input.context ?? {};
  const requestText = [input.request, input.userIntent]
    .filter(Boolean)
    .join(" ");
  const normalized = requestText.toLowerCase();

  const freshTerms = [
    "fresh",
    "grocery",
    "groceries",
    "delivery slot",
    "whole foods",
  ];
  const placeOrderTerms = [
    "place order",
    "submit order",
    "buy now",
    "checkout",
    "order it",
  ];
  const cartTerms = [
    "cart",
    "basket",
    "review items",
    "what's in cart",
    "what is in cart",
  ];
  const variantTerms = [
    "size",
    "color",
    "flavor",
    "pack",
    "quantity",
    "variant",
    "option",
  ];

  const reasons: string[] = [];

  if (includesAny(normalized, placeOrderTerms)) {
    if (!context.checkoutReviewed) {
      reasons.push(
        "User requested order placement before checkout was reviewed.",
      );
      return {
        step: "checkout_review",
        confidence: 0.92,
        reasons,
        needsExplicitConfirmation: false,
        suggestedNextAction:
          "Review checkout totals and payment/shipping details before final confirmation.",
      };
    }

    reasons.push(
      "User explicitly requested order placement and checkout appears reviewed.",
    );
    return {
      step: "place_order",
      confidence: 0.94,
      reasons,
      needsExplicitConfirmation: true,
      suggestedNextAction:
        "Collect final explicit confirmation immediately before clicking the order submission button.",
    };
  }

  if (includesAny(normalized, cartTerms) || context.hasCartItems) {
    reasons.push("Request references cart state or existing cart items.");
    return {
      step: "cart_review",
      confidence: 0.83,
      reasons,
      needsExplicitConfirmation: false,
      suggestedNextAction:
        "Open cart page, parse itemized totals, and confirm intended items.",
    };
  }

  if (includesAny(normalized, freshTerms) && !context.freshSlotSelected) {
    reasons.push(
      "Request appears to be Amazon Fresh flow without a selected slot.",
    );
    return {
      step: "fresh_slot",
      confidence: 0.8,
      reasons,
      needsExplicitConfirmation: false,
      suggestedNextAction:
        "Navigate to delivery slot selection and confirm slot availability before checkout.",
    };
  }

  if (includesAny(normalized, variantTerms)) {
    reasons.push("Request references a product variant dimension.");
    return {
      step: "variant_select",
      confidence: 0.74,
      reasons,
      needsExplicitConfirmation: false,
      suggestedNextAction:
        "Open product details and resolve required variant choices before adding to cart.",
    };
  }

  reasons.push("Defaulting to product discovery workflow.");
  return {
    step: "search",
    confidence: 0.68,
    reasons,
    needsExplicitConfirmation: false,
    suggestedNextAction:
      "Run product search and present top options with price and Prime/Fresh hints.",
  };
}

async function main(): Promise<void> {
  try {
    const { args, payload } = await parseCliInput<AmazonIntentInput>(
      process.argv.slice(2),
      {},
    );

    const request =
      (typeof args.request === "string" ? args.request : undefined) ??
      payload.request;

    const contextFromArgs: AmazonIntentContext = {
      cartConfirmed: toBool(args["cart-confirmed"]),
      checkoutReviewed: toBool(args["checkout-reviewed"]),
      freshSlotSelected: toBool(args["fresh-slot-selected"]),
      hasCartItems: toBool(args["has-cart-items"]),
    };

    const mergedContext: AmazonIntentContext = {
      ...(payload.context ?? {}),
      ...Object.fromEntries(
        Object.entries(contextFromArgs).filter(([, value]) => value === true),
      ),
    };

    const result = classifyAmazonIntent({
      ...payload,
      request,
      context: mergedContext,
    });

    printJson({ ok: true, data: result });
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
  }
}

if (import.meta.main) {
  await main();
}
