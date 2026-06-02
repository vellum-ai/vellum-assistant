import { useMutation, useQuery } from "@tanstack/react-query";

import {
  configLlmProfilesGet,
  memoryV2NowtextGet,
  memoryV2RouterprompttemplateGet,
  memoryV2SimulaterouterPost,
} from "@/generated/daemon/sdk.gen";

import type {
  ConfigLlmProfilesGetResponse,
  MemoryV2NowtextGetResponse,
  MemoryV2RouterprompttemplateGetResponse,
  MemoryV2SimulaterouterPostData,
  MemoryV2SimulaterouterPostResponse,
} from "@/generated/daemon/types.gen";

/**
 * Client for the daemon's read-only memory-router playground endpoints,
 * served through the generated daemon SDK (the wildcard runtime-proxy
 * routes are now typed). Covers `simulate-router`, the bundled
 * `router-prompt-template`, the live `now-text`, and the `llm/profiles`
 * list that populates the per-call profile dropdown.
 */

/** Request body for `simulate-router`, derived from the generated SDK. */
export type MemoryRouterSimulateRequest = NonNullable<
  MemoryV2SimulaterouterPostData["body"]
>;

/** A single (assistant, user) turn pair rendered inside `<last_turn>`. */
export type RecentTurnPair =
  MemoryRouterSimulateRequest["recentTurnPairs"][number];

/** Successful `simulate-router` response. */
export type MemoryRouterSimulateResponse = MemoryV2SimulaterouterPostResponse;

/** Sorted profile names plus the workspace-wide active profile. */
export type LlmProfilesListResponse = ConfigLlmProfilesGetResponse;

/**
 * Result of a successful simulate call, including the pretty-printed
 * request body that was sent and the raw response body returned. Surfaced
 * in the playground's "Raw API exchange" disclosure for debugging.
 */
export interface MemoryRouterSimulateResult {
  response: MemoryRouterSimulateResponse;
  rawRequest: string;
  rawResponse: string;
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
  signal?: AbortSignal,
): Promise<MemoryRouterSimulateResult> {
  const { data, response } = await memoryV2SimulaterouterPost({
    path: { assistant_id: assistantId },
    body: request,
    signal,
    throwOnError: false,
  });
  const rawResponse = response
    ? await response
        .clone()
        .text()
        .catch(() => "")
    : "";
  if (!response || !response.ok) {
    throw new SimulateMemoryRouterError(
      response?.status ?? 0,
      rawResponse || response?.statusText || "Failed to simulate memory router",
    );
  }
  if (!data) {
    throw new SimulateMemoryRouterError(
      response.status,
      "Empty response from memory router simulator endpoint",
    );
  }
  return {
    response: data,
    rawRequest: JSON.stringify(request, null, 2),
    rawResponse: prettyJson(rawResponse),
  };
}

function prettyJson(raw: string): string {
  if (raw.length === 0) return raw;
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export function useSimulateMemoryRouter(assistantId: string | undefined) {
  return useMutation({
    mutationFn: async (
      request: MemoryRouterSimulateRequest,
    ): Promise<MemoryRouterSimulateResult> => {
      if (!assistantId) {
        throw new SimulateMemoryRouterError(0, "Missing assistantId");
      }
      return simulateMemoryRouter(assistantId, request);
    },
  });
}

async function fetchLlmProfiles(
  assistantId: string,
  signal?: AbortSignal,
): Promise<LlmProfilesListResponse> {
  const { data, response } = await configLlmProfilesGet({
    path: { assistant_id: assistantId },
    signal,
    throwOnError: false,
  });
  if (!response || !response.ok) {
    throw new SimulateMemoryRouterError(
      response?.status ?? 0,
      response?.statusText ?? "Failed to load LLM profiles",
    );
  }
  if (!data) {
    throw new SimulateMemoryRouterError(
      response.status,
      "Empty response from profile list endpoint",
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

async function fetchRouterPromptTemplate(
  assistantId: string,
  signal?: AbortSignal,
): Promise<MemoryV2RouterprompttemplateGetResponse> {
  const { data, response } = await memoryV2RouterprompttemplateGet({
    path: { assistant_id: assistantId },
    signal,
    throwOnError: false,
  });
  if (!response || !response.ok) {
    throw new SimulateMemoryRouterError(
      response?.status ?? 0,
      response?.statusText ?? "Failed to load router prompt template",
    );
  }
  if (!data) {
    throw new SimulateMemoryRouterError(
      response.status,
      "Empty response from router prompt template endpoint",
    );
  }
  return data;
}

export function useDefaultRouterPromptTemplate(
  assistantId: string | undefined,
) {
  return useQuery({
    queryKey: ["router-prompt-template", assistantId] as const,
    queryFn: async ({
      signal,
    }): Promise<MemoryV2RouterprompttemplateGetResponse> => {
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

async function fetchCurrentNowText(
  assistantId: string,
  signal?: AbortSignal,
): Promise<MemoryV2NowtextGetResponse> {
  const { data, response } = await memoryV2NowtextGet({
    path: { assistant_id: assistantId },
    signal,
    throwOnError: false,
  });
  if (!response || !response.ok) {
    throw new SimulateMemoryRouterError(
      response?.status ?? 0,
      response?.statusText ?? "Failed to load NOW.md",
    );
  }
  if (!data) {
    throw new SimulateMemoryRouterError(
      response.status,
      "Empty response from now-text endpoint",
    );
  }
  return data;
}

export function useCurrentNowText(assistantId: string | undefined) {
  return useQuery({
    queryKey: ["memory-router-now-text", assistantId] as const,
    queryFn: async ({ signal }): Promise<MemoryV2NowtextGetResponse> => {
      if (!assistantId) {
        throw new SimulateMemoryRouterError(0, "Missing assistantId");
      }
      return fetchCurrentNowText(assistantId, signal);
    },
    enabled: Boolean(assistantId),
    // NOW.md only changes when the assistant rewrites it — refresh on
    // navigation, not on a timer.
    staleTime: Infinity,
  });
}
