import { _setOverridesForTesting } from "../../../config/assistant-feature-flags.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MockedResponse {
  body?: unknown;
  status: number;
}

interface MockFetchEntry {
  path: string;
  init: Partial<RequestInit>;
  response: MockedResponse | Response;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let originalFetch: typeof globalThis.fetch;
let entries: MockFetchEntry[] = [];
let calls: { path: string; init: RequestInit }[] = [];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function setupEmailTests(): {
  getCalls: () => { path: string; init: RequestInit }[];
} {
  return { getCalls: () => calls };
}

export function beforeEachEmailTest(): void {
  originalFetch = globalThis.fetch;
  entries = [];
  calls = [];
  process.exitCode = 0;
  _setOverridesForTesting({ "email-channel": true });
}

export function afterEachEmailTest(): void {
  globalThis.fetch = originalFetch;
  entries = [];
  calls = [];
  _setOverridesForTesting({});
  process.exitCode = 0;
}

/**
 * Register a mock fetch response. When the mock fetch is invoked, it matches
 * against registered entries by checking that the request path contains `path`
 * and that every key in `init` matches the actual request init.
 *
 * Entries are consumed in order — the first match wins and is removed, so you
 * can register multiple responses for the same path to simulate sequences.
 */
export function mockFetch(
  path: string,
  init: Partial<RequestInit>,
  response: MockedResponse | Response,
): void {
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

/**
 * Run an assistant CLI command via the real program, capturing stdout.
 */
export async function runAssistantCommand(...args: string[]): Promise<string> {
  const { buildCliProgram } = await import("../../program.js");
  const program = buildCliProgram();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });

  const chunks: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(
      typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
    );
    return true;
  }) as typeof process.stdout.write;

  try {
    await program.parseAsync(["node", "assistant", ...args]);
  } catch {
    /* commander exit override throws */
  } finally {
    process.stdout.write = originalWrite;
  }

  return chunks.join("");
}
