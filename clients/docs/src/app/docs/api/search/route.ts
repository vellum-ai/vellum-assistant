import { NextRequest, NextResponse } from "next/server";

import { loadDocsSearchIndex } from "@/lib/docs/search/index-loader";
import { searchDocsIndex } from "@/lib/docs/search/ranker";
import { isRateLimited, resolveClientIp } from "@/lib/docs/search/rate-limit";
import type { DocsSearchResponse } from "@/lib/docs/search/types";

const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 160;

// Parses only; the ranker owns defaulting and clamping.
function parseLimit(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function buildResponse(body: DocsSearchResponse, cacheControl: string): NextResponse<DocsSearchResponse> {
  return NextResponse.json(body, {
    headers: {
      "Cache-Control": cacheControl,
    },
  });
}

export async function GET(request: NextRequest) {
  const startedAt = performance.now();

  const ip = resolveClientIp(request.headers.get("x-forwarded-for"));
  if (isRateLimited(ip)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429, headers: { "Retry-After": "60" } });
  }

  try {
    const query = request.nextUrl.searchParams.get("q")?.trim() ?? "";
    const limit = parseLimit(request.nextUrl.searchParams.get("limit"));

    if (query.length < MIN_QUERY_LENGTH || query.length > MAX_QUERY_LENGTH) {
      return buildResponse(
        {
          query,
          tookMs: Math.round(performance.now() - startedAt),
          results: [],
        },
        "no-store"
      );
    }

    const index = await loadDocsSearchIndex();

    const results = searchDocsIndex({
      query,
      limit,
      index,
    });

    return buildResponse(
      {
        query,
        tookMs: Math.round(performance.now() - startedAt),
        results,
      },
      "private, max-age=30"
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    console.error(`[docs-search] search endpoint error: ${message}`);

    return buildResponse(
      {
        query: "",
        tookMs: Math.round(performance.now() - startedAt),
        results: [],
      },
      "no-store"
    );
  }
}
