/**
 * Points a generated HeyAPI client at an in-memory handler for the life of a
 * Storybook story, so a component that fetches its own data renders from
 * fixtures. Returns the function that restores the client's configuration;
 * a story's `beforeEach` returns it as its cleanup.
 */

/** Answers one request the story's component makes. */
export type StoryFetchHandler = (
  request: Request,
) => Response | Promise<Response>;

interface StubbableClientConfig {
  baseUrl?: string;
  fetch?: typeof fetch;
}

interface StubbableClient<TConfig extends StubbableClientConfig> {
  getConfig(): TConfig;
  setConfig(config: TConfig): unknown;
}

/** A base URL no request can reach, so a miss in the handler never leaves the page. */
const STORY_BASE_URL = "https://storybook.invalid";

export function stubClientFetch<TConfig extends StubbableClientConfig>(
  client: StubbableClient<TConfig>,
  handler: StoryFetchHandler,
): () => void {
  const snapshot = client.getConfig();
  const storyFetch = (input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(
      handler(input instanceof Request ? input : new Request(input, init)),
    );
  client.setConfig({
    ...snapshot,
    baseUrl: STORY_BASE_URL,
    fetch: Object.assign(storyFetch, { preconnect: () => {} }),
  });
  return () => {
    client.setConfig(snapshot);
  };
}

/** The answer for a request the story's fixture does not cover. */
export function fixtureNotFound(): Response {
  return Response.json(
    { error: "This request is not part of the story fixture." },
    { status: 404 },
  );
}
