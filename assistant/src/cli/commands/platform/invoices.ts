import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../../ipc/cli-client.js";
import { subcommand } from "../../lib/cli-command-help.js";
import { log } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";

interface PlatformInvoice {
  id: string;
  number: string | null;
  status: string | null;
  currency: string;
  amount_due: number;
  amount_paid: number;
  amount_remaining: number;
  created: number;
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
}

interface PlatformInvoicesListResult {
  invoices: PlatformInvoice[];
  has_more: boolean;
}

/**
 * These lists follow Stripe's amount scaling rules
 * (https://docs.stripe.com/currencies), not ISO 4217 metadata. Notably,
 * Stripe keeps two-decimal scaling for ISK, HUF, TWD, and UGX for backward
 * compatibility even though ISO treats them as zero-decimal, so those codes
 * are deliberately absent from the zero-decimal list.
 */
const STRIPE_ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

const STRIPE_THREE_DECIMAL_CURRENCIES = new Set([
  "BHD",
  "JOD",
  "KWD",
  "OMR",
  "TND",
]);

function stripeScaleDigits(currencyCode: string): number {
  if (STRIPE_ZERO_DECIMAL_CURRENCIES.has(currencyCode)) {
    return 0;
  }
  if (STRIPE_THREE_DECIMAL_CURRENCIES.has(currencyCode)) {
    return 3;
  }
  return 2;
}

/**
 * Amounts are in Stripe's minor units; render as major units using Stripe's
 * amount scaling rules (2 for USD, 0 for JPY, 3 for BHD), e.g. "USD 12.34".
 * The display fraction digits are forced to match the same scale so Intl's
 * ISO metadata cannot round Stripe's two-decimal special cases (ISK, HUF,
 * TWD, UGX). Unknown currency codes fall back to the raw minor-unit amount.
 */
function formatInvoiceAmount(
  amountMinorUnits: number,
  currency: string,
): string {
  const code = currency.toUpperCase();
  const digits = stripeScaleDigits(code);
  try {
    const formatter = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
      currencyDisplay: "code",
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
    // Intl separates the code and number with U+00A0; use a plain space.
    return formatter
      .format(amountMinorUnits / 10 ** digits)
      .replace(/\u00a0/g, " ");
  } catch {
    // Intl.NumberFormat throws a RangeError on invalid currency codes.
    return `${amountMinorUnits} ${code} (minor units)`;
  }
}

function logInvoice(invoice: PlatformInvoice, includePdf: boolean): void {
  log.info(invoice.number ?? invoice.id);
  log.info(`  Status:  ${invoice.status ?? "unknown"}`);
  log.info(
    `  Amount:  ${formatInvoiceAmount(invoice.amount_due, invoice.currency)}`,
  );
  log.info(
    `  Created: ${new Date(invoice.created * 1000).toISOString().slice(0, 10)}`,
  );
  if (invoice.hosted_invoice_url) {
    log.info(`  URL:     ${invoice.hosted_invoice_url}`);
  }
  if (includePdf && invoice.invoice_pdf) {
    log.info(`  PDF:     ${invoice.invoice_pdf}`);
  }
}

export function registerPlatformInvoicesCommands(platform: Command): void {
  const invoices = subcommand(platform, "invoices");

  subcommand(invoices, "list").action(
    async (opts: { startingAfter?: string }, cmd: Command) => {
      const r = await cliIpcCall<PlatformInvoicesListResult>(
        "platform_invoices_list",
        opts.startingAfter
          ? { queryParams: { starting_after: opts.startingAfter } }
          : {},
      );
      if (!r.ok) {
        return exitFromIpcResult(
          { ok: false, error: r.error, statusCode: r.statusCode },
          cmd,
        );
      }

      const result = r.result!;

      if (shouldOutputJson(cmd)) {
        writeOutput(cmd, result);
      } else {
        if (result.invoices.length === 0) {
          log.info("No invoices found.");
        } else {
          for (const invoice of result.invoices) {
            logInvoice(invoice, false);
            log.info("");
          }
        }
        const lastId = result.invoices.at(-1)?.id;
        if (result.has_more && lastId) {
          log.info(
            `More invoices available. Run 'assistant platform invoices list --starting-after ${lastId}' for the next page.`,
          );
        }
      }
    },
  );

  subcommand(invoices, "get").action(
    async (invoiceId: string, _opts: Record<string, unknown>, cmd: Command) => {
      const r = await cliIpcCall<PlatformInvoice>("platform_invoices_get", {
        pathParams: { id: invoiceId },
      });
      if (!r.ok) {
        return exitFromIpcResult(
          { ok: false, error: r.error, statusCode: r.statusCode },
          cmd,
        );
      }

      if (shouldOutputJson(cmd)) {
        writeOutput(cmd, r.result!);
      } else {
        logInvoice(r.result!, true);
      }
    },
  );
}
