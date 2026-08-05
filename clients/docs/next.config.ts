import type { NextConfig } from "next";

// Requests that ask for text/markdown receive the generated Markdown mirror
// (the /docs/_md route, src/app/docs/%5Fmd/[[...slug]]/route.ts) instead of
// the HTML page.
// Browsers never send text/markdown in Accept, so human traffic is unaffected.
// The negative lookahead skips ranges explicitly marked unacceptable with
// q=0, scanning past any preceding media-type parameters (e.g. charset).
const MARKDOWN_ACCEPT_HEADER = {
  type: "header" as const,
  key: "accept",
  value:
    "(.*?)text/markdown(?!(?:\\s*;\\s*[^;,=]+=[^;,]*)*\\s*;\\s*q=0(?:\\.0{1,3})?\\s*(?:,|$))(.*)",
};

const nextConfig: NextConfig = {
  output: "standalone",
  typedRoutes: true,
  // Ingress only routes /docs/* to this app, so the build's static assets
  // must be referenced under that prefix; the /docs/_next rewrite below maps
  // them back to Next's real /_next filesystem route.
  assetPrefix: "/docs",
  // The /_next/image optimizer endpoint is NOT covered by assetPrefix and
  // would resolve outside the /docs ingress prefix. Assets are pre-sized
  // WebP, so serve them as-is.
  images: { unoptimized: true },
  // Without this, Next's middleware adapter strips the router prefetch
  // headers (Next-Router-Prefetch, Next-Router-Segment-Prefetch, RSC) before
  // src/proxy.ts runs, so isPrefetch() could never suppress segment-cache
  // prefetches and every landing would emit a burst of phantom page_view
  // rows (see FLIGHT_HEADERS in next/dist/server/web/adapter.js).
  skipMiddlewareUrlNormalize: true,
  async redirects() {
    return [
      // Legacy /docs URLs that permanently redirect to their successors.
      {
        source: "/docs/data-sharing",
        destination: "/docs/privacy-policy",
        permanent: true,
      },
      {
        source: "/docs/affiliate-program-rules",
        destination: "/docs",
        permanent: true,
      },
      {
        source: "/docs/vellum-survey-giveaway-official-rules",
        destination: "/docs",
        permanent: true,
      },
    ];
  },
  async rewrites() {
    return {
      beforeFiles: [
        {
          // Counterpart of assetPrefix: serve the prefixed asset URLs from
          // Next's real static route. Ordered first so no other rule can
          // capture an asset path.
          source: "/docs/_next/:path*",
          destination: "/_next/:path*",
        },
        //
        // The `.md` URL-suffix rules are ordered BEFORE the Accept rules
        // because the permissive `/docs/:path` Accept rule would otherwise
        // capture a `.md` request, keep the `.md` in its `:path` capture, and
        // 404. Only paths ending in `.md` match here, so real HTML pages,
        // /docs/llms.txt, and other static assets are untouched.
        {
          // The docs index mirror. /docs/index.md (not /docs.md) keeps the
          // public URL under /docs/, the only prefix ingress routes here.
          source: "/docs/index.md",
          destination: "/docs/_md",
        },
        {
          source: "/docs/:path*.md",
          destination: "/docs/_md/:path*",
        },
        //
        // Content negotiation for AI agents (Claude Code, Cursor, etc.).
        //
        // CDN caveat: Next.js strips custom Vary headers from prerendered
        // page responses, so the HTML representation cannot advertise
        // "Vary: Accept". No edge cache sits in front of this backend, so
        // every request reaches the origin and negotiation is always
        // evaluated. If Cloud CDN is ever enabled for this backend, its
        // cache key policy must include the Accept header or agents will be
        // served cached HTML.
        {
          source: "/docs",
          destination: "/docs/_md",
          has: [MARKDOWN_ACCEPT_HEADER],
        },
        {
          // Leave the generated agent index (/docs/llms.txt) to public-file
          // serving even when agents send Accept: text/markdown, and keep the
          // /docs/api subtree and the mirror route itself out of negotiation.
          // The lookaheads anchor on a following slash or end-of-path so the
          // bare /docs/api and /docs/_md paths are excluded while sibling
          // prefixes (e.g. a hypothetical /docs/api-guide) still negotiate.
          source: "/docs/:path((?!llms\\.txt$)(?!api(?:\\/|$))(?!_md(?:\\/|$)).*)",
          destination: "/docs/_md/:path",
          has: [MARKDOWN_ACCEPT_HEADER],
        },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
