/**
 * Unit tests for the platform_invoices_list and platform_invoices_get route
 * handlers: cursor forwarding, page walking, the page cap, and error paths.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  BadRequestError,
  InternalError,
  NotFoundError,
  UnprocessableEntityError,
} from "../errors.js";

let platformBaseUrl = "https://platform.test";
let authHeader: string | null = "Api-Key test";

// Spread the real module: replacing it wholesale breaks unrelated importers
// pulled in by the module under test.
const actualRegistration =
  await import("../../../inbound/platform-callback-registration.js");
mock.module("../../../inbound/platform-callback-registration.js", () => ({
  ...actualRegistration,
  resolvePlatformCallbackRegistrationContext: async () => ({
    isPlatform: false,
    platformBaseUrl,
    assistantId: "assistant-123",
    hasAssistantApiKey: !!authHeader,
    authHeader,
    enabled: !!(platformBaseUrl && authHeader),
  }),
}));

const { ROUTES } = await import("../platform-routes.js");

const listHandler = ROUTES.find(
  (r) => r.operationId === "platform_invoices_list",
)!.handler;
const getHandler = ROUTES.find(
  (r) => r.operationId === "platform_invoices_get",
)!.handler;

const INVOICES_URL = "https://platform.test/v1/organizations/billing/invoices/";
const MAX_INVOICE_PAGES = 25;

function invoice(id: string) {
  return {
    id,
    number: `INV-${id}`,
    status: "paid",
    currency: "usd",
    amount_due: 1234,
    amount_paid: 1234,
    amount_remaining: 0,
    created: 1750000000,
    hosted_invoice_url: `https://stripe.test/${id}`,
    invoice_pdf: null,
  };
}

interface FetchCall {
  url: string;
  init?: RequestInit;
}

const realFetch = globalThis.fetch;
let fetchCalls: FetchCall[] = [];

/** Stub globalThis.fetch, recording calls and answering via `respond`. */
function stubFetch(
  respond: (url: string, callIndex: number) => Response | Promise<Response>,
): void {
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    fetchCalls.push({ url, init });
    return respond(url, fetchCalls.length - 1);
  }) as typeof fetch;
}

/** Await a handler call that must reject, returning the thrown error. */
async function expectRejection(run: () => unknown): Promise<Error> {
  try {
    await run();
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected rejection");
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  platformBaseUrl = "https://platform.test";
  authHeader = "Api-Key test";
  fetchCalls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("platform_invoices_list", () => {
  test("returns the platform page and calls the bare invoices URL", async () => {
    const page = { invoices: [invoice("in_1")], has_more: false };
    stubFetch(() => jsonResponse(page));

    expect(await listHandler({})).toEqual(page);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe(INVOICES_URL);
    expect(
      (fetchCalls[0]!.init?.headers as Record<string, string>).Authorization,
    ).toBe("Api-Key test");
  });

  test("forwards starting_after as a cursor and passes has_more through", async () => {
    const page = { invoices: [invoice("in_2")], has_more: true };
    stubFetch(() => jsonResponse(page));

    const result = await listHandler({
      queryParams: { starting_after: "in_a" },
    });

    expect(fetchCalls[0]!.url).toBe(`${INVOICES_URL}?starting_after=in_a`);
    expect((result as { has_more: boolean }).has_more).toBe(true);
  });

  test("rejects with UnprocessableEntityError when credentials are missing", async () => {
    platformBaseUrl = "";
    stubFetch(() => jsonResponse({ invoices: [], has_more: false }));

    await expect(listHandler({})).rejects.toBeInstanceOf(
      UnprocessableEntityError,
    );
    expect(fetchCalls).toHaveLength(0);
  });

  test("rejects with InternalError naming the status on a non-OK response", async () => {
    stubFetch(() => jsonResponse({ detail: "boom" }, 500));

    const err = await expectRejection(() => listHandler({}));
    expect(err).toBeInstanceOf(InternalError);
    expect(err.message).toMatch(/HTTP 500/);
  });

  test("rejects with BadRequestError carrying the detail on an upstream 400", async () => {
    stubFetch(
      () => new Response("Invalid starting_after cursor", { status: 400 }),
    );

    const err = await expectRejection(() =>
      listHandler({ queryParams: { starting_after: "in_bogus" } }),
    );
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err.message).toMatch(/Invalid starting_after cursor/);
    expect(err.message).toMatch(/starting_after/);
  });
});

describe("platform_invoices_get", () => {
  test("resolves an invoice found on the first page with one fetch", async () => {
    const target = invoice("in_target");
    stubFetch(() =>
      jsonResponse({ invoices: [invoice("in_1"), target], has_more: false }),
    );

    expect(await getHandler({ pathParams: { id: "in_target" } })).toEqual(
      target,
    );
    expect(fetchCalls).toHaveLength(1);
  });

  test("follows the cursor to a later page using the last invoice's id", async () => {
    const target = invoice("in_target");
    stubFetch((_url, callIndex) =>
      callIndex === 0
        ? jsonResponse({
            invoices: [invoice("in_a"), invoice("in_b")],
            has_more: true,
          })
        : jsonResponse({ invoices: [target], has_more: false }),
    );

    expect(await getHandler({ pathParams: { id: "in_target" } })).toEqual(
      target,
    );
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[1]!.url).toBe(`${INVOICES_URL}?starting_after=in_b`);
  });

  test("rejects with an actionable NotFoundError when the id is absent", async () => {
    stubFetch(() =>
      jsonResponse({ invoices: [invoice("in_other")], has_more: false }),
    );

    const err = await expectRejection(() =>
      getHandler({ pathParams: { id: "in_missing" } }),
    );
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.message).toMatch(
      /Invoice "in_missing" not found.*assistant platform invoices list/,
    );
    // No paging beyond the final (has_more: false) page.
    expect(fetchCalls).toHaveLength(1);
  });

  test("stops after MAX_INVOICE_PAGES pages when every page has more", async () => {
    stubFetch((_url, callIndex) =>
      jsonResponse({
        invoices: [invoice(`in_${callIndex}`)],
        has_more: true,
      }),
    );

    await expect(
      getHandler({ pathParams: { id: "in_never" } }),
    ).rejects.toBeInstanceOf(InternalError);
    expect(fetchCalls).toHaveLength(MAX_INVOICE_PAGES);
  });

  test("stops the cursor walk when the request abort signal fires", async () => {
    const controller = new AbortController();
    stubFetch(() => {
      // Abort after the first page has been served; the handler must not
      // fetch a second page.
      controller.abort();
      return jsonResponse({ invoices: [invoice("in_a")], has_more: true });
    });

    const err = await expectRejection(() =>
      getHandler({
        pathParams: { id: "in_never" },
        abortSignal: controller.signal,
      }),
    );
    expect(err).toBeInstanceOf(InternalError);
    expect(err.message).toMatch(/aborted/);
    expect(fetchCalls).toHaveLength(1);
  });

  test("threads the request abort signal into the page fetch", async () => {
    const controller = new AbortController();
    stubFetch(() =>
      jsonResponse({ invoices: [invoice("in_target")], has_more: false }),
    );

    await getHandler({
      pathParams: { id: "in_target" },
      abortSignal: controller.signal,
    });

    // The fetch signal must be derived from the caller's signal: aborting
    // the request aborts the in-flight platform fetch.
    const fetchSignal = fetchCalls[0]!.init?.signal as AbortSignal;
    expect(fetchSignal.aborted).toBe(false);
    controller.abort();
    expect(fetchSignal.aborted).toBe(true);
  });

  test("rejects with BadRequestError when the id path param is missing", async () => {
    stubFetch(() => jsonResponse({ invoices: [], has_more: false }));

    await expect(getHandler({})).rejects.toBeInstanceOf(BadRequestError);
    expect(fetchCalls).toHaveLength(0);
  });
});
