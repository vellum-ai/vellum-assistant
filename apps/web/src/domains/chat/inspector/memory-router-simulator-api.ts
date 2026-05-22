import { useMutation, useQuery } from "@tanstack/react-query";

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
  /** Per-call `llm.profiles` override name. Omit to use the active profile. */
  profileOverride?: string;
  /**
   * Inline router system-prompt override. Empty / whitespace-only strings
   * are treated as no-override server-side.
   */
  routerPromptOverride?: string;
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
  /** Profile name passed as an override on this call, or null if none. */
  profileOverride: string | null;
  /** True when an inline router prompt override was applied this call. */
  routerPromptOverridden: boolean;
}

export interface LlmProfilesListResponse {
  profiles: string[];
  activeProfile: string | null;
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

async function fetchLlmProfiles(
  assistantId: string,
  signal?: AbortSignal
): Promise<LlmProfilesListResponse> {
  const { data, response } = await client.get<LlmProfilesListResponse>({
    url: "/v1/assistants/{assistant_id}/config/llm/profiles/",
    path: { assistant_id: assistantId },
    signal,
    throwOnError: false,
  });
  if (!response || !response.ok) {
    throw new SimulateMemoryRouterError(
      response?.status ?? 0,
      response?.statusText ?? "Failed to load LLM profiles"
    );
  }
  if (!data) {
    throw new SimulateMemoryRouterError(
      response.status,
      "Empty response from profile list endpoint"
    );
  }
  return data;
}

export function useLlmProfiles(assistantId: string | undefined) {
  return useQuery({
    queryKey: ["llm-profiles", assistantId] as const,
    queryFn: async ({ signal }): Promise<LlmProfilesListResponse> => {
      if (!assistantId) {
        throw new SimulateMemoryRouterError(0, "Missing assistantId");
      }
      return fetchLlmProfiles(assistantId, signal);
    },
    enabled: Boolean(assistantId),
    staleTime: 60_000,
  });
}

interface RouterPromptTemplateResponse {
  template: string;
}

async function fetchRouterPromptTemplate(
  assistantId: string,
  signal?: AbortSignal
): Promise<RouterPromptTemplateResponse> {
  const { data, response } = await client.get<RouterPromptTemplateResponse>({
    url: "/v1/assistants/{assistant_id}/memory/v2/router-prompt-template/",
    path: { assistant_id: assistantId },
    signal,
    throwOnError: false,
  });
  if (!response || !response.ok) {
    throw new SimulateMemoryRouterError(
      response?.status ?? 0,
      response?.statusText ?? "Failed to load router prompt template"
    );
  }
  if (!data) {
    throw new SimulateMemoryRouterError(
      response.status,
      "Empty response from router prompt template endpoint"
    );
  }
  return data;
}

export function useDefaultRouterPromptTemplate(
  assistantId: string | undefined
) {
  return useQuery({
    queryKey: ["router-prompt-template", assistantId] as const,
    queryFn: async ({ signal }): Promise<RouterPromptTemplateResponse> => {
      if (!assistantId) {
        throw new SimulateMemoryRouterError(0, "Missing assistantId");
      }
      return fetchRouterPromptTemplate(assistantId, signal);
    },
    enabled: Boolean(assistantId),
    // The template only changes when the daemon ships, so cache aggressively.
    staleTime: 24 * 60 * 60 * 1000,
  });
}
