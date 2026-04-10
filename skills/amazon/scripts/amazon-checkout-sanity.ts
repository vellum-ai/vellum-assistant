#!/usr/bin/env bun

import { normalizeWhitespace, parseCliInput, printError, printJson } from "./lib/common.js";

export interface CheckoutSanityInput {
  text?: string;
  extracted?: {
    text?: string;
  };
  context?: {
    cartConfirmed?: boolean;
  };
}

export interface CheckoutSanityResult {
  ready: boolean;
  missing: string[];
  riskFlags: string[];
  detected: {
    shippingAddress: boolean;
    paymentMethod: boolean;
    orderTotal: boolean;
    submitAction: boolean;
    cancellationFeeNotice: boolean;
  };
}

function detect(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

export function evaluateCheckoutSanity(input: CheckoutSanityInput): CheckoutSanityResult {
  const rawText = input.text ?? input.extracted?.text ?? "";
  const text = normalizeWhitespace(rawText);

  const shippingAddress = detect(text, [
    /deliver to/i,
    /ship to/i,
    /shipping address/i,
    /delivery address/i,
  ]);

  const paymentMethod = detect(text, [
    /payment method/i,
    /ending in\s*\d{4}/i,
    /visa|mastercard|amex|discover/i,
  ]);

  const orderTotal = detect(text, [
    /order total/i,
    /total before tax/i,
    /estimated total/i,
    /\$\s*[0-9][0-9,]*(?:\.[0-9]{2})?/, // fallback
  ]);

  const submitAction = detect(text, [
    /place your order/i,
    /submit order/i,
    /buy now/i,
    /complete purchase/i,
  ]);

  const cancellationFeeNotice = detect(text, [
    /cancellation fee/i,
    /no-show fee/i,
    /non-refundable/i,
    /deposit required/i,
  ]);

  const missing: string[] = [];
  if (!shippingAddress) missing.push("shipping_address");
  if (!paymentMethod) missing.push("payment_method");
  if (!orderTotal) missing.push("order_total");
  if (!submitAction) missing.push("submit_action");

  const riskFlags: string[] = [];
  if (!input.context?.cartConfirmed) {
    riskFlags.push("cart_not_explicitly_confirmed");
  }
  if (cancellationFeeNotice) {
    riskFlags.push("fee_notice_present");
  }

  return {
    ready: missing.length === 0,
    missing,
    riskFlags,
    detected: {
      shippingAddress,
      paymentMethod,
      orderTotal,
      submitAction,
      cancellationFeeNotice,
    },
  };
}

async function main(): Promise<void> {
  try {
    const { args, payload } = await parseCliInput<CheckoutSanityInput>(
      process.argv.slice(2),
      {},
    );

    const text =
      (typeof args.text === "string" ? args.text : undefined) ?? payload.text;

    const cartConfirmedArg = args["cart-confirmed"];
    const context = {
      ...(payload.context ?? {}),
      ...(cartConfirmedArg === undefined
        ? {}
        : { cartConfirmed: String(cartConfirmedArg).toLowerCase() === "true" }),
    };

    const data = evaluateCheckoutSanity({
      ...payload,
      text,
      context,
    });

    printJson({ ok: true, data });
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
  }
}

if (import.meta.main) {
  await main();
}
