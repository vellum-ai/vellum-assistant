import { useMutation } from "@tanstack/react-query";

import { client } from "@/generated/api/client.gen.js";

/**
 * Client for the daemon's read-only memory-router simulator endpoint.
 *
 * Mirrors the daemon route at `POST /v1/memory/v2/simulate-router`
 * (operationId `memory_v2_simulate_router`), reached through the
 * gateway's runtime-proxy wildcard at
 * `/v1/assistants/{assistantId}/memory/v2/simulate-router/`. Not in
 * the generated OpenAPI client (the wildcard proxy isn't typed), so
 * we call `client.post` directly and carry the response shape locally.
 */

export type RouterSource = "tier1" | "tier2" | `tier3:${number}`;

export interface MemoryRouterSimulateRequest {
  query: string;
  configOverrides?: {
    tier1_size?: number | null;
    tier2_size?: number | null;
    batch_size?: number | null;
  };
}

export interface MemoryRouterSimulateEffectiveConfig {
  tier1_size: number | null;
  tier2_size: number | null;
  batch_size: number | null;
  max_page_ids: number;
}

export interface MemoryRouterSimulateResponse {
  selectedSlugs: string[];
  sourceBySlug: Record<string, RouterSource>;
  scores: Record<string, number>;
  failureReason: string | null;
  effectiveConfig: MemoryRouterSimulateEffectiveConfig;
  overrides: {
    tier1_size?: number | null;
    tier2_size?: number | null;
    batch_size?: number | null;
  };
  totalCandidatePages: number;
}

export class SimulateMemoryRouterError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "SimulateMemoryRouterError";
    this.status = status;
  }
}

export async function simulateMemoryRouter(
  assistantId: string,
  request: MemoryRouterSimulateRequest,
  signal?: AbortSignal
): Promise<MemoryRouterSimulateResponse> {
  const { data, response } = await client.post<MemoryRouterSimulateResponse>({
    url: "/v1/assistants/{assistant_id}/memory/v2/simulate-router/",
    path: { assistant_id: assistantId },
    body: request,
    signal,
    throwOnError: false,
  });
  if (!response || !response.ok) {
    const text = await response
      ?.clone()
      .text()
      .catch(() => "");
    throw new SimulateMemoryRouterError(
      response?.status ?? 0,
      text || response?.statusText || "Failed to simulate memory router"
    );
  }
  if (!data) {
    throw new SimulateMemoryRouterError(
      response.status,
      "Empty response from memory router simulator endpoint"
    );
  }
  return data;
}

export function useSimulateMemoryRouter(assistantId: string | undefined) {
  return useMutation({
    mutationFn: async (
      request: MemoryRouterSimulateRequest
    ): Promise<MemoryRouterSimulateResponse> => {
      if (!assistantId) {
        throw new SimulateMemoryRouterError(0, "Missing assistantId");
      }
      return simulateMemoryRouter(assistantId, request);
    },
  });
}
