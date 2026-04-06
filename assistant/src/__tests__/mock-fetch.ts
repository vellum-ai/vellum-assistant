/**
 * Global test utility for mocking `globalThis.fetch`.
 *
 * Usage:
 *   mockFetch("/some/path", { method: "POST" }, { body: { ok: true }, status: 200 });
 *
 * Entries are consumed in order — the first match wins and is removed, so
 * register multiple responses for the same path to simulate sequences.
 */

interface MockedResponse {
  body?: unknown;
  status: number;
}

interface MockFetchEntry {
  path: string;
  init: Partial<RequestInit>;
  response: MockedResponse | Response;
}

const entries: MockFetchEntry[] = [];
const calls: { path: string; init: RequestInit }[] = [];
let originalFetch: typeof globalThis.fetch | undefined;

export function mockFetch(
  path: string,
  init: Partial<RequestInit>,
  response: MockedResponse | Response,
): void {
  if (!originalFetch) {
    originalFetch = globalThis.fetch;
  }

  entries.push({ path, init, response });

  globalThis.fetch = (async (
    input: RequestInfo | URL,
    actualInit?: RequestInit,
  ) => {
    const url = String(input);
    calls.push({ path: url, init: actualInit ?? {} });

    const idx = entries.findIndex((e) => {
      if (!url.includes(e.path)) return false;
      for (const [key, val] of Object.entries(e.init)) {
        if (
          (actualInit as Record<string, unknown> | undefined)?.[key] !== val
        ) {
          return false;
        }
      }
      return true;
    });

    if (idx === -1) {
      return new Response(JSON.stringify({ detail: "No mock matched" }), {
        status: 500,
      });
    }

    const entry = entries[idx];
    entries.splice(idx, 1);

    if (entry.response instanceof Response) {
      return entry.response;
    }

    return new Response(JSON.stringify(entry.response.body ?? null), {
      status: entry.response.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
}

export function getMockFetchCalls(): { path: string; init: RequestInit }[] {
  return calls;
}

export function resetMockFetch(): void {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = undefined;
  }
  entries.length = 0;
  calls.length = 0;
}
