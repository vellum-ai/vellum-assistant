// Hand-written fetch wrapper: the radio route is served by the assistant
// runtime through the gateway proxy and is not part of Django OpenAPI yet.
import { client } from "@/generated/api/client.gen";
import type {
  RadioAdvanceRequest,
  RadioAdvanceResponse,
} from "@/domains/radio/types.js";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";
import { routes } from "@/utils/routes.js";

export { ApiError };

export const RADIO_TTS_SETTINGS_PATH = routes.settings.ai;

export const SDK_BASE_OPTIONS =
  typeof window === "undefined"
    ? ({ baseUrl: "http://localhost" } as const)
    : ({} as const);

export async function advanceRadio(
  assistantId: string,
  request: RadioAdvanceRequest
): Promise<RadioAdvanceResponse> {
  const { data, error, response } = await client.post<
    RadioAdvanceResponse,
    unknown
  >({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/radio/advance/",
    path: { assistant_id: assistantId },
    body: request,
    headers: { "Content-Type": "application/json" },
    throwOnError: false,
  });

  assertHasResponse(response, error, "Failed to advance radio.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to advance radio.")
    );
  }

  if (!data) {
    throw new ApiError(response.status, "Radio response was empty.");
  }

  return data;
}

export function runtimeAudioUrl(
  assistantId: string,
  audioPath: string
): string {
  const encodedAssistantId = encodeURIComponent(assistantId);
  const pathSegments = normalizeRuntimeAudioPath(audioPath);
  const encodedPath = pathSegments.map(encodeURIComponent).join("/");

  return `/v1/assistants/${encodedAssistantId}/${encodedPath}/`;
}

function normalizeRuntimeAudioPath(audioPath: string): string[] {
  const segments = audioPath
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (segments.length === 0) {
    throw new Error("Radio audio path is required.");
  }

  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("Radio audio path cannot include traversal segments.");
  }

  const isDemoTrackPath =
    segments[0] === "radio" && segments[1] === "tracks" && segments.length >= 3;
  const isDjAudioPath = segments[0] === "audio" && segments.length >= 2;

  if (!isDemoTrackPath && !isDjAudioPath) {
    throw new Error("Unsupported radio audio path.");
  }

  return segments;
}
