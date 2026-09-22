import { describe, expect, test } from "bun:test";
import { useQuery } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";

import {
  createStoryQueryClient,
  withQueryCache,
} from "@/lib/story-query-cache";

describe("createStoryQueryClient", () => {
  test("seeds the entries the callback writes", () => {
    const client = createStoryQueryClient((c) => {
      c.setQueryData<string>(["greeting"], "hello");
    });
    expect(client.getQueryData<string>(["greeting"])).toBe("hello");
  });

  test("never retries, refetches, goes stale or drops an entry", () => {
    const { queries } = createStoryQueryClient().getDefaultOptions();
    expect(queries?.retry).toBe(false);
    expect(queries?.staleTime).toBe(Infinity);
    expect(queries?.gcTime).toBe(Infinity);
    expect(queries?.refetchOnMount).toBe(false);
    expect(queries?.refetchOnWindowFocus).toBe(false);
    expect(queries?.refetchOnReconnect).toBe(false);
  });
});

describe("withQueryCache", () => {
  test("provides the seeded cache to the story", () => {
    function Greeting() {
      const { data } = useQuery({
        queryKey: ["greeting"],
        queryFn: () => "fetched",
      });
      return <span>{data}</span>;
    }
    const decorator = withQueryCache((c) => {
      c.setQueryData<string>(["greeting"], "seeded");
    });
    const html = renderToStaticMarkup(decorator(Greeting));
    expect(html).toContain("seeded");
  });
});
