import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typedRoutes: true,
  // Without this, Next's middleware adapter strips the router prefetch
  // headers (Next-Router-Prefetch, Next-Router-Segment-Prefetch, RSC) before
  // src/proxy.ts runs, so isPrefetch() could never suppress segment-cache
  // prefetches and every landing would emit a burst of phantom page_view
  // rows (see FLIGHT_HEADERS in next/dist/server/web/adapter.js).
  skipMiddlewareUrlNormalize: true,
};

export default nextConfig;
