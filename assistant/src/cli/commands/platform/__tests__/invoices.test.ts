import { beforeEach, describe, expect, test } from "bun:test";

import {
  runPlatform,
  runPlatformCaught,
  setupPlatformIpcMock,
} from "./helpers.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const invoiceA = {
  id: "in_a",
  number: "INV-0001",
  status: "paid",
  currency: "usd",
  amount_due: 1234,
  amount_paid: 1234,
  amount_remaining: 0,
  created: 1750000000,
  hosted_invoice_url: "https://pay.example.com/in_a",
  invoice_pdf: "https://pay.example.com/in_a.pdf",
};

const invoiceB = {
  id: "in_b",
  number: null,
  status: "open",
  currency: "usd",
  amount_due: 5600,
  amount_paid: 0,
  amount_remaining: 5600,
  created: 1747000000,
  hosted_invoice_url: null,
  invoice_pdf: null,
};

const ipc = setupPlatformIpcMock();

function runInvoices(args: string[]): Promise<string[]> {
  return runPlatform(["invoices", ...args]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("assistant platform invoices list", () => {
  beforeEach(() => {
    ipc.calls = [];
    ipc.response = {
      ok: true,
      result: { invoices: [invoiceA, invoiceB], has_more: false },
    };
  });

  test("calls platform_invoices_list and emits the page as JSON with --json", async () => {
    const out = await runInvoices(["list", "--json"]);

    expect(ipc.calls[0][0]).toBe("platform_invoices_list");
    expect(ipc.calls[0][1]).toEqual({});

    const parsed = JSON.parse(out.join(""));
    expect(parsed.invoices).toHaveLength(2);
    expect(parsed.invoices[0].id).toBe("in_a");
    expect(parsed.has_more).toBe(false);
  });

  test("forwards --starting-after as the starting_after query param", async () => {
    await runInvoices(["list", "--starting-after", "in_a", "--json"]);

    expect(ipc.calls[0][0]).toBe("platform_invoices_list");
    expect(ipc.calls[0][1]).toEqual({
      queryParams: { starting_after: "in_a" },
    });
  });

  test("plain text mode renders number, status, and amount lines", async () => {
    const out = await runInvoices(["list"]);
    const text = out.join("");

    expect(text).toContain("INV-0001");
    expect(text).toContain("Status:  paid");
    expect(text).toContain("Amount:  USD 12.34");
    expect(text).toContain("https://pay.example.com/in_a");
    // Invoice with a null number falls back to its id.
    expect(text).toContain("in_b");
    expect(text).toContain("Amount:  USD 56.00");
    // Not JSON output.
    expect(() => JSON.parse(text.trim())).toThrow();
  });

  test("plain text mode reports an empty page", async () => {
    ipc.response = { ok: true, result: { invoices: [], has_more: false } };

    const out = await runInvoices(["list"]);

    expect(out.join("").trim()).toBe("No invoices found.");
  });

  test("plain text mode ends with a paging hint when has_more is true", async () => {
    ipc.response = {
      ok: true,
      result: { invoices: [invoiceA, invoiceB], has_more: true },
    };

    const out = await runInvoices(["list"]);

    expect(out.join("").trim()).toEndWith(
      "More invoices available. Run 'assistant platform invoices list --starting-after in_b' for the next page.",
    );
  });

  test("plain text mode omits the paging hint when has_more is false", async () => {
    const out = await runInvoices(["list"]);

    expect(out.join("")).not.toContain("More invoices available");
  });
});

describe("assistant platform invoices get", () => {
  beforeEach(() => {
    ipc.calls = [];
    ipc.response = { ok: true, result: invoiceA };
  });

  test("calls platform_invoices_by_id_get with the id path param and emits JSON with --json", async () => {
    const out = await runInvoices(["get", "in_123", "--json"]);

    expect(ipc.calls[0][0]).toBe("platform_invoices_by_id_get");
    expect(ipc.calls[0][1]).toEqual({ pathParams: { id: "in_123" } });

    const parsed = JSON.parse(out.join(""));
    expect(parsed.id).toBe("in_a");
    expect(parsed.amount_due).toBe(1234);
  });

  test("plain text mode renders the invoice block including the PDF link", async () => {
    const out = await runInvoices(["get", "in_a"]);
    const text = out.join("");

    expect(text).toContain("INV-0001");
    expect(text).toContain("Status:  paid");
    expect(text).toContain("Amount:  USD 12.34");
    expect(text).toContain("PDF:     https://pay.example.com/in_a.pdf");
  });

  test("plain text mode scales zero-decimal currencies without dividing by 100", async () => {
    ipc.response = {
      ok: true,
      result: { ...invoiceA, currency: "jpy", amount_due: 1200 },
    };

    const out = await runInvoices(["get", "in_a"]);

    expect(out.join("")).toContain("Amount:  JPY 1,200");
  });

  test("plain text mode uses three decimals for three-decimal currencies", async () => {
    ipc.response = {
      ok: true,
      result: { ...invoiceA, currency: "bhd", amount_due: 12345 },
    };

    const out = await runInvoices(["get", "in_a"]);

    expect(out.join("")).toContain("Amount:  BHD 12.345");
  });

  test("plain text mode keeps Stripe's two-decimal scaling for ISK despite ISO zero-decimal metadata", async () => {
    ipc.response = {
      ok: true,
      result: { ...invoiceA, currency: "isk", amount_due: 500 },
    };

    const out = await runInvoices(["get", "in_a"]);

    expect(out.join("")).toContain("Amount:  ISK 5.00");
  });

  test("plain text mode falls back to raw minor units for invalid currency codes", async () => {
    ipc.response = {
      ok: true,
      result: { ...invoiceA, currency: "zz", amount_due: 1234 },
    };

    const out = await runInvoices(["get", "in_a"]);

    expect(out.join("")).toContain("Amount:  1234 ZZ (minor units)");
  });
});

describe("assistant platform invoices error handling", () => {
  beforeEach(() => {
    ipc.calls = [];
    ipc.response = {
      ok: false,
      error: "Platform credentials not available",
      statusCode: 422,
    };
  });

  test("list exits via exitFromIpcResult on IPC failure without writing output", async () => {
    const { out, thrown } = await runPlatformCaught(["invoices", "list"]);

    expect((thrown as Error).message).toBe("exitFromIpcResult called");
    expect(out.join("")).toBe("");
  });

  test("get exits via exitFromIpcResult on IPC failure without writing output", async () => {
    const { out, thrown } = await runPlatformCaught([
      "invoices",
      "get",
      "in_missing",
    ]);

    expect((thrown as Error).message).toBe("exitFromIpcResult called");
    expect(out.join("")).toBe("");
  });
});

describe("assistant platform invoices --help", () => {
  test("group help renders both subcommands", async () => {
    const { out } = await runPlatformCaught(["invoices", "--help"]);
    const text = out.join("");

    expect(text).toContain("list");
    expect(text).toContain("get");
    expect(text).toContain("Stripe invoice history");
  });

  test("list help renders the --starting-after option", async () => {
    const { out } = await runPlatformCaught(["invoices", "list", "--help"]);

    expect(out.join("")).toContain("--starting-after <invoice-id>");
  });
});
