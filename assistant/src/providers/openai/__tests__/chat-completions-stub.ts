/**
 * Shared stub harness for OpenAIChatCompletionsProvider suites. The provider
 * instance is passed in by the test file so this helper never imports from
 * `src/` (see the test-machinery isolation rule in the root AGENTS.md).
 */

export type ReasoningDetail = {
  type?: string;
  summary?: string | null;
  text?: string | null;
};

export type MockChunkDelta = {
  content?: string | null;
  reasoning?: string | null;
  reasoning_content?: string | null;
  reasoning_details?: ReasoningDetail[] | null;
};

export type MockChunk = {
  choices: Array<{ delta: MockChunkDelta; finish_reason?: string | null }>;
  model?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
      cache_write_tokens?: number;
    };
  };
};

export function makeStream(chunks: MockChunk[]): AsyncIterable<MockChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) {
        yield c;
      }
    },
  };
}

export function rejection(message: string, status = 400): Error {
  return Object.assign(new Error(message), { status });
}

/**
 * Swap the provider's SDK client for a stub whose chat.completions.create
 * throws the queued `errors` in order (one per call) before streaming the
 * canned `chunks`. Returns the per-call request snapshots — snapshots, not
 * references, because the compatibility fallbacks mutate `params` between
 * attempts.
 */
export function stubClient(
  provider: object,
  chunks: MockChunk[],
  errors: unknown[] = [],
): unknown[] {
  const requests: unknown[] = [];
  const pending = [...errors];
  (provider as { client: unknown }).client = {
    chat: {
      completions: {
        create: async (params: unknown) => {
          requests.push(JSON.parse(JSON.stringify(params)));
          const error = pending.shift();
          if (error !== undefined) {
            throw error;
          }
          return makeStream(chunks);
        },
      },
    },
  };
  return requests;
}
