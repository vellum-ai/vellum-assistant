import { useMutation, useQuery } from "@tanstack/react-query";

import { memoryV2SimulaterouterPost } from "@/generated/daemon/sdk.gen";
import {
  configLlmProfilesGetOptions,
  memoryV2NowtextGetOptions,
  memoryV2RouterprompttemplateGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";

import type {
  ConfigLlmProfilesGetResponse,
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

export function useLlmProfiles(assistantId: string | undefined) {
  return useQuery({
    ...configLlmProfilesGetOptions({
      path: { assistant_id: assistantId! },
    }),
    enabled: Boolean(assistantId),
    staleTime: 60_000,
  });
}

export function useDefaultRouterPromptTemplate(
  assistantId: string | undefined,
) {
  return useQuery({
    ...memoryV2RouterprompttemplateGetOptions({
      path: { assistant_id: assistantId! },
    }),
    enabled: Boolean(assistantId),
    staleTime: 24 * 60 * 60 * 1000,
  });
}

export function useCurrentNowText(assistantId: string | undefined) {
  return useQuery({
    ...memoryV2NowtextGetOptions({
      path: { assistant_id: assistantId! },
    }),
    enabled: Boolean(assistantId),
    staleTime: Infinity,
  });
}
