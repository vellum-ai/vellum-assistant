import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

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

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockCalls: Array<[string, Record<string, unknown>]> = [];
let mockResponse: unknown = {
  ok: true,
  result: { invoices: [invoiceA, invoiceB], has_more: false },
};

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params: Record<string, unknown>) => {
    mockCalls.push([method, params]);
    return mockResponse;
  },
  exitFromIpcResult: (_r: unknown, _cmd: unknown) => {
    throw new Error("exitFromIpcResult called");
  },
}));

const { registerPlatformCommand } = await import("../index.js");

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerPlatformCommand(program);
  return program;
}

function captureStdout(fn: () => Promise<void>): Promise<string[]> {
  const chunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return fn()
    .then(() => chunks)
    .finally(() => {
      process.stdout.write = origWrite;
    });
}

async function runInvoices(args: string[]): Promise<string[]> {
  return captureStdout(async () => {
    const program = buildProgram();
    await program.parseAsync([
      "node",
      "assistant",
      "platform",
      "invoices",
      ...args,
    ]);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("assistant platform invoices list", () => {
  beforeEach(() => {
    mockCalls = [];
    mockResponse = {
      ok: true,
      result: { invoices: [invoiceA, invoiceB], has_more: false },
    };
    process.exitCode = 0;
  });

  test("calls platform_invoices_list and emits the page as JSON with --json", async () => {
    const out = await runInvoices(["list", "--json"]);

    expect(mockCalls[0][0]).toBe("platform_invoices_list");
    expect(mockCalls[0][1]).toEqual({});

    const parsed = JSON.parse(out.join(""));
    expect(parsed.invoices).toHaveLength(2);
    expect(parsed.invoices[0].id).toBe("in_a");
    expect(parsed.has_more).toBe(false);
  });

  test("forwards --starting-after as the starting_after query param", async () => {
    await runInvoices(["list", "--starting-after", "in_a", "--json"]);

    expect(mockCalls[0][0]).toBe("platform_invoices_list");
    expect(mockCalls[0][1]).toEqual({
      queryParams: { starting_after: "in_a" },
    });
  });

  test("plain text mode renders number, status, and amount lines", async () => {
    const out = await runInvoices(["list"]);
    const text = out.join("");

    expect(text).toContain("INV-0001");
    expect(text).toContain("Status:  paid");
    expect(text).toContain("Amount:  $12.34 USD");
    expect(text).toContain("https://pay.example.com/in_a");
    // Invoice with a null number falls back to its id.
    expect(text).toContain("in_b");
    expect(text).toContain("Amount:  $56.00 USD");
    // Not JSON output.
    expect(() => JSON.parse(text.trim())).toThrow();
  });

  test("plain text mode reports an empty page", async () => {
    mockResponse = { ok: true, result: { invoices: [], has_more: false } };

    const out = await runInvoices(["list"]);

    expect(out.join("").trim()).toBe("No invoices found.");
  });

  test("plain text mode ends with a paging hint when has_more is true", async () => {
    mockResponse = {
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
    mockCalls = [];
    mockResponse = { ok: true, result: invoiceA };
    process.exitCode = 0;
  });

  test("calls platform_invoices_get with the id path param and emits JSON with --json", async () => {
    const out = await runInvoices(["get", "in_123", "--json"]);

    expect(mockCalls[0][0]).toBe("platform_invoices_get");
    expect(mockCalls[0][1]).toEqual({ pathParams: { id: "in_123" } });

    const parsed = JSON.parse(out.join(""));
    expect(parsed.id).toBe("in_a");
    expect(parsed.amount_due).toBe(1234);
  });

  test("plain text mode renders the invoice block including the PDF link", async () => {
    const out = await runInvoices(["get", "in_a"]);
    const text = out.join("");

    expect(text).toContain("INV-0001");
    expect(text).toContain("Status:  paid");
    expect(text).toContain("Amount:  $12.34 USD");
    expect(text).toContain("PDF:     https://pay.example.com/in_a.pdf");
  });
});

describe("assistant platform invoices error handling", () => {
  beforeEach(() => {
    mockCalls = [];
    mockResponse = {
      ok: false,
      error: "Platform credentials not available",
      statusCode: 422,
    };
    process.exitCode = 0;
  });

  test("list exits via exitFromIpcResult on IPC failure without writing output", async () => {
    let thrown: unknown;
    const out = await captureStdout(async () => {
      const program = buildProgram();
      try {
        await program.parseAsync([
          "node",
          "assistant",
          "platform",
          "invoices",
          "list",
        ]);
      } catch (err) {
        thrown = err;
      }
    });

    expect((thrown as Error).message).toBe("exitFromIpcResult called");
    expect(out.join("")).toBe("");
  });

  test("get exits via exitFromIpcResult on IPC failure without writing output", async () => {
    let thrown: unknown;
    const out = await captureStdout(async () => {
      const program = buildProgram();
      try {
        await program.parseAsync([
          "node",
          "assistant",
          "platform",
          "invoices",
          "get",
          "in_missing",
        ]);
      } catch (err) {
        thrown = err;
      }
    });

    expect((thrown as Error).message).toBe("exitFromIpcResult called");
    expect(out.join("")).toBe("");
  });
});

describe("assistant platform invoices --help", () => {
  test("group help renders both subcommands", async () => {
    const out = await captureStdout(async () => {
      const program = buildProgram();
      try {
        await program.parseAsync([
          "node",
          "assistant",
          "platform",
          "invoices",
          "--help",
        ]);
      } catch {
        // exitOverride throws on --help; ignore
      }
    });
    const text = out.join("");

    expect(text).toContain("list");
    expect(text).toContain("get");
    expect(text).toContain("Stripe invoice history");
  });

  test("list help renders the --starting-after option", async () => {
    const out = await captureStdout(async () => {
      const program = buildProgram();
      try {
        await program.parseAsync([
          "node",
          "assistant",
          "platform",
          "invoices",
          "list",
          "--help",
        ]);
      } catch {
        // exitOverride throws on --help; ignore
      }
    });

    expect(out.join("")).toContain("--starting-after <invoice-id>");
  });
});
