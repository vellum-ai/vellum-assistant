import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realRQ from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";

import { DEFAULT_EMPTY_STATE_GREETING } from "@/domains/chat/utils/empty-state-constants";
import { assistantIdentityIntroQueryKey } from "@/lib/sync/query-tags";

interface CapturedQueryOptions {
  queryKey: readonly unknown[];
  queryFn: () => Promise<readonly string[] | null>;
  enabled: boolean;
  staleTime: number;
}

let lastCapturedOptions: CapturedQueryOptions | null = null;

interface UseQueryStub {
  data: readonly string[] | null | undefined;
}

let useQueryStub: UseQueryStub = { data: undefined };

mock.module("@tanstack/react-query", () => ({
  ...realRQ,
  useQuery: (options: CapturedQueryOptions) => {
    lastCapturedOptions = options;
    return useQueryStub;
  },
}));

interface ClientResponse {
  data: unknown;
  error: unknown;
  response: { ok: boolean };
}

const clientCalls: unknown[] = [];
let clientResponse: ClientResponse = {
  data: null,
  error: null,
  response: { ok: true },
};

mock.module("@/domains/chat/api/client", () => ({
  SDK_BASE_OPTIONS: {},
  assertHasResponse: () => {},
  client: {
    get: (options: unknown) => {
      clientCalls.push(options);
      return Promise.resolve(clientResponse);
    },
  },
}));

import { useEmptyStateGreeting } from "@/domains/chat/hooks/use-empty-state-greeting";

function HookHarness({
  assistantId,
  collect,
}: {
  assistantId: string | null | undefined;
  collect: (result: string) => void;
}): null {
  collect(useEmptyStateGreeting(assistantId));
  return null;
}

function runHook(assistantId: string | null | undefined): string {
  let captured: string | null = null;
  renderToStaticMarkup(
    <HookHarness
      assistantId={assistantId}
      collect={(result) => {
        captured = result;
      }}
    />,
  );
  if (captured === null) {
    throw new Error("HookHarness did not invoke the hook");
  }
  return captured;
}

const originalRandom = Math.random;

beforeEach(() => {
  lastCapturedOptions = null;
  clientCalls.length = 0;
  clientResponse = { data: null, error: null, response: { ok: true } };
  useQueryStub = { data: undefined };
  Math.random = originalRandom;
});

afterEach(() => {
  Math.random = originalRandom;
});

describe("useEmptyStateGreeting", () => {
  test("uses the identity intro query key for the active assistant", () => {
    runHook("asst-1");

    expect(lastCapturedOptions?.queryKey).toEqual(
      assistantIdentityIntroQueryKey("asst-1"),
    );
    expect(lastCapturedOptions?.enabled).toBe(true);
  });

  test("falls back when no greeting candidates are loaded", () => {
    expect(runHook("asst-1")).toBe(DEFAULT_EMPTY_STATE_GREETING);
  });

  test("selects one greeting candidate from the daemon response", () => {
    useQueryStub = { data: ["First greeting", "Second greeting"] };
    Math.random = () => 0.99;

    expect(runHook("asst-1")).toBe("Second greeting");
  });

  test("queryFn returns trimmed greetings from the daemon array", async () => {
    clientResponse = {
      data: {
        greetings: ["  First greeting  ", "", "Second greeting"],
        text: "Legacy text",
      },
      error: null,
      response: { ok: true },
    };

    runHook("asst-1");
    const result = await lastCapturedOptions!.queryFn();

    expect(result).toEqual(["First greeting", "Second greeting"]);
    expect(clientCalls).toHaveLength(1);
    expect((clientCalls[0] as { url: string }).url).toBe(
      "/v1/assistants/{assistant_id}/identity/intro",
    );
  });

  test("queryFn falls back to legacy text when greetings are absent", async () => {
    clientResponse = {
      data: { text: "  Legacy greeting  " },
      error: null,
      response: { ok: true },
    };

    runHook("asst-1");
    const result = await lastCapturedOptions!.queryFn();

    expect(result).toEqual(["Legacy greeting"]);
  });
});
