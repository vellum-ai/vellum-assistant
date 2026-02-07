import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/agents": ["./agent-templates/**/*"],
  },
};

export default nextConfig;
